#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-treetopia-prod}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-2}}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.micro}"
ROOT_VOLUME_SIZE="${ROOT_VOLUME_SIZE:-16}"
KEY_NAME="${KEY_NAME:-treetopia-key}"
KEY_FILE="${KEY_FILE:-$HOME/${KEY_NAME}.pem}"
SG_NAME="${SG_NAME:-${APP_NAME}-sg}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

aws_text() {
  aws "$@" --region "$REGION" --output text
}

aws_json() {
  aws "$@" --region "$REGION" --output json
}

authorize_ingress() {
  local port="$1"
  local cidr="$2"
  local err_file

  err_file="$(mktemp)"
  if aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,IpRanges=[{CidrIp=$cidr}]" \
    --region "$REGION" >/dev/null 2>"$err_file"; then
    echo "Opened TCP $port from $cidr"
    rm -f "$err_file"
    return
  fi

  if grep -q 'InvalidPermission.Duplicate' "$err_file"; then
    echo "TCP $port from $cidr already exists."
    rm -f "$err_file"
    return
  fi

  cat "$err_file" >&2
  rm -f "$err_file"
  exit 1
}

require_command aws

echo "Using AWS region: $REGION"
ACCOUNT_ID="$(aws_text sts get-caller-identity --query Account)"
echo "Using AWS account: $ACCOUNT_ID"

VPC_ID="$(aws_text ec2 describe-vpcs --filters 'Name=is-default,Values=true' --query 'Vpcs[0].VpcId')"
if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
  echo "No default VPC found; creating one."
  VPC_ID="$(aws_text ec2 create-default-vpc --query 'Vpc.VpcId')"
fi
echo "Using VPC: $VPC_ID"

SUBNET_ID="$(aws_text ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" 'Name=default-for-az,Values=true' --query 'Subnets[0].SubnetId')"
if [ "$SUBNET_ID" = "None" ] || [ -z "$SUBNET_ID" ]; then
  SUBNET_ID="$(aws_text ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --query 'Subnets[0].SubnetId')"
fi
echo "Using subnet: $SUBNET_ID"

SG_ID="$(aws_text ec2 describe-security-groups --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[0].GroupId')"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(aws_text ec2 create-security-group --group-name "$SG_NAME" --description 'TreeTopia web and deploy access' --vpc-id "$VPC_ID" --query GroupId)"
  aws_json ec2 create-tags --resources "$SG_ID" --tags "Key=Name,Value=$SG_NAME" >/dev/null
fi
echo "Using security group: $SG_ID"

# SSH is open to GitHub-hosted Actions runners for automatic deploys.
# Harden this later with SSM or a self-hosted runner if the game grows.
authorize_ingress 22 0.0.0.0/0
authorize_ingress 80 0.0.0.0/0
authorize_ingress 443 0.0.0.0/0

if aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" >/dev/null 2>&1; then
  if [ -f "$KEY_FILE" ]; then
    echo "Using existing key pair and local key file: $KEY_FILE"
  else
    KEY_NAME="${KEY_NAME}-$(date +%Y%m%d%H%M%S)"
    KEY_FILE="$HOME/${KEY_NAME}.pem"
    echo "Existing AWS key pair had no local private key; creating $KEY_NAME instead."
    aws_text ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial >"$KEY_FILE"
    chmod 400 "$KEY_FILE"
  fi
else
  echo "Creating key pair: $KEY_NAME"
  aws_text ec2 create-key-pair --key-name "$KEY_NAME" --query KeyMaterial >"$KEY_FILE"
  chmod 400 "$KEY_FILE"
fi

AMI_ID="$(aws_text ec2 describe-images \
  --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=architecture,Values=x86_64' 'Name=virtualization-type,Values=hvm' \
  --query 'Images | sort_by(@, &CreationDate)[-1].ImageId')"
ROOT_DEVICE="$(aws_text ec2 describe-images --image-ids "$AMI_ID" --query 'Images[0].RootDeviceName')"
echo "Using Ubuntu AMI: $AMI_ID"

INSTANCE_ID="$(aws_text ec2 describe-instances \
  --filters "Name=tag:Name,Values=$APP_NAME" 'Name=instance-state-name,Values=pending,running,stopping,stopped' \
  --query 'Reservations[].Instances[].InstanceId | [0]')"

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
  USER_DATA_FILE="$(mktemp)"
  cat >"$USER_DATA_FILE" <<'USERDATA'
#!/bin/bash
set -euxo pipefail
cat >/tmp/bootstrap-ubuntu.sh <<'BOOTSTRAP'
#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/opt/treetopia}"
DATA_DIR="${DATA_DIR:-/var/lib/treetopia}"
DOMAIN="${DOMAIN:-_}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg nginx

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

mkdir -p "$APP_DIR/releases" "$DATA_DIR/worlds"
chown -R "$APP_USER:$APP_USER" "$APP_DIR" "$DATA_DIR"

cat >/etc/systemd/system/treetopia.service <<SERVICE
[Unit]
Description=TreeTopia Node game server
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR/current
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DATA_DIR=$DATA_DIR
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
SERVICE

cat >/etc/nginx/sites-available/treetopia <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600;
        proxy_send_timeout 3600;
    }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/treetopia /etc/nginx/sites-enabled/treetopia

systemctl daemon-reload
systemctl enable treetopia
systemctl enable nginx
nginx -t
systemctl restart nginx

cat <<EOF
TreeTopia host bootstrap complete.

Next:
1. Add GitHub Actions secrets: AWS_HOST, AWS_USER, AWS_SSH_KEY.
2. Run the "Deploy to AWS EC2" workflow from GitHub Actions.
3. After first deploy, check: sudo systemctl status treetopia
EOF
BOOTSTRAP

APP_USER=ubuntu DOMAIN=_ bash /tmp/bootstrap-ubuntu.sh
USERDATA

  echo "Launching EC2 instance: $APP_NAME"
  INSTANCE_ID="$(aws_text ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --subnet-id "$SUBNET_ID" \
    --associate-public-ip-address \
    --user-data "file://$USER_DATA_FILE" \
    --block-device-mappings "DeviceName=$ROOT_DEVICE,Ebs={VolumeSize=$ROOT_VOLUME_SIZE,VolumeType=gp3,DeleteOnTermination=false}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$APP_NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$APP_NAME-root}]" \
    --query 'Instances[0].InstanceId')"
else
  STATE="$(aws_text ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].State.Name')"
  echo "Found existing instance $INSTANCE_ID ($STATE)."
  if [ "$STATE" = "stopped" ]; then
    aws_json ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
  fi
fi

echo "Waiting for instance to run: $INSTANCE_ID"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

ALLOCATION_ID="$(aws_text ec2 describe-addresses --filters "Name=tag:Name,Values=$APP_NAME-eip" --query 'Addresses[0].AllocationId')"
if [ "$ALLOCATION_ID" = "None" ] || [ -z "$ALLOCATION_ID" ]; then
  ALLOCATION_ID="$(aws_text ec2 allocate-address --domain vpc --query AllocationId)"
  aws_json ec2 create-tags --resources "$ALLOCATION_ID" --tags "Key=Name,Value=$APP_NAME-eip" >/dev/null
fi
aws_json ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOCATION_ID" --allow-reassociation >/dev/null
PUBLIC_IP="$(aws_text ec2 describe-addresses --allocation-ids "$ALLOCATION_ID" --query 'Addresses[0].PublicIp')"

cat <<EOF

TreeTopia AWS server is provisioned.

Instance ID: $INSTANCE_ID
Elastic IP: $PUBLIC_IP
Game URL: http://$PUBLIC_IP
Private key saved in CloudShell: $KEY_FILE

Add these GitHub Actions secrets:
AWS_HOST=$PUBLIC_IP
AWS_USER=ubuntu
AWS_SSH_KEY=copy the full contents of $KEY_FILE

Then run GitHub Actions > Deploy to AWS EC2 > Run workflow.
EOF
