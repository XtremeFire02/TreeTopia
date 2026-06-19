# TreeTopia on AWS EC2

This deploy path runs TreeTopia 24/7 on one Ubuntu EC2 server. Nginx receives public
browser traffic on port 80 and proxies it to the Node/WebSocket game server on localhost
port 3000. Runtime data is stored outside the release folder at `/var/lib/treetopia`.

## Fast path with AWS CloudShell

In the AWS Console, open CloudShell in region `ap-southeast-2`, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/XtremeFire02/TreeTopia/main/deploy/aws/provision-cloudshell.sh -o provision-cloudshell.sh
bash provision-cloudshell.sh
```

The script creates the EC2 instance, security group, Elastic IP, and SSH key pair.
After it prints the Elastic IP, add the printed values as GitHub Actions secrets and run
the `Deploy to AWS EC2` workflow.

If the `curl` command returns `404`, the repository is probably private. Either make the
repo public temporarily, or copy `deploy/aws/provision-cloudshell.sh` from GitHub and
paste it into CloudShell as a file before running it.

## Manual path: 1. Create the AWS server

1. Open AWS EC2 and choose **Launch instance**.
2. Name it `treetopia-prod`.
3. Pick a region close to your players, for example Sydney `ap-southeast-2`.
4. Choose **Ubuntu Server 24.04 LTS**.
5. Choose `t3.micro` to start, or `t3.small` if more people will be online.
6. Create and download a key pair named `treetopia-key.pem`.
7. Create a security group with these inbound rules:
   - SSH `22` from `0.0.0.0/0` so GitHub Actions can deploy over SSH.
   - HTTP `80` from `0.0.0.0/0`.
   - HTTPS `443` from `0.0.0.0/0`.
8. Use at least a 16 GB gp3 root volume.
9. Launch the instance.

Do not open port `3000` to the internet. Nginx is the public entry point.
For better hardening later, replace public SSH with AWS Systems Manager or a self-hosted
GitHub Actions runner.

## 2. Give it a permanent address

1. In EC2, open **Elastic IPs**.
2. Allocate one Elastic IP.
3. Associate it to the `treetopia-prod` instance.

Your temporary game link will be:

```text
http://YOUR_ELASTIC_IP
```

If you own a domain, create an `A` record like `play.yourdomain.com` pointing to the
Elastic IP.

## 3. Bootstrap the instance

SSH into the server from PowerShell:

```powershell
ssh -i C:\path\to\treetopia-key.pem ubuntu@YOUR_ELASTIC_IP
```

If Windows says the key permissions are too open, run:

```powershell
icacls C:\path\to\treetopia-key.pem /inheritance:r
icacls C:\path\to\treetopia-key.pem /grant:r "$env:USERNAME:R"
```

Then run this on the EC2 server:

```bash
curl -fsSL https://raw.githubusercontent.com/XtremeFire02/TreeTopia/main/deploy/aws/bootstrap-ubuntu.sh -o bootstrap-ubuntu.sh
sudo APP_USER=ubuntu DOMAIN=_ bash bootstrap-ubuntu.sh
```

If you are using a domain, use it instead:

```bash
sudo APP_USER=ubuntu DOMAIN=play.yourdomain.com bash bootstrap-ubuntu.sh
```

## 4. Add GitHub secrets

Open GitHub repo **Settings > Secrets and variables > Actions > New repository secret**
and add:

```text
AWS_HOST=YOUR_ELASTIC_IP
AWS_USER=ubuntu
AWS_SSH_KEY=the full contents of treetopia-key.pem
```

`AWS_SSH_KEY` must include the `BEGIN` and `END` lines.

## 5. Deploy

Open GitHub **Actions > Deploy to AWS EC2 > Run workflow**.

After it finishes, open:

```text
http://YOUR_ELASTIC_IP
```

Every future push to `main` deploys automatically.

## Useful server commands

```bash
sudo systemctl status treetopia
sudo journalctl -u treetopia -f
sudo systemctl restart treetopia
```

Back up game data:

```bash
sudo tar -czf /tmp/treetopia-data-$(date +%F).tar.gz /var/lib/treetopia
```

If you use a domain and want HTTPS:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d play.yourdomain.com
```
