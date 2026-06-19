export const DEVELOPER_NAME = '@XtremeFire';
export const DEVELOPER_NAME_COLOR = '#b8860b';
export const DEVELOPER_NAME_STROKE = 'rgba(43,29,0,.9)';

export function isDeveloperName(name) {
  return String(name || '').toLowerCase() === DEVELOPER_NAME.toLowerCase();
}
