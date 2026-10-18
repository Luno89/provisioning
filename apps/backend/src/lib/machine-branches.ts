const MACHINE_BRANCHES = 'machine';

const safe = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 120) || 'work';

export const machineBranch = (deviceId: string, key: string): string => `${MACHINE_BRANCHES}/${safe(deviceId)}/${safe(key)}`;

export const machineRefPrefix = (deviceId: string): string => `refs/heads/${MACHINE_BRANCHES}/${safe(deviceId)}/`;

export const mayPushRef = (deviceId: string, ref: string): boolean =>
  ref.startsWith(machineRefPrefix(deviceId)) && !ref.slice(machineRefPrefix(deviceId).length).includes('..');

export const machineFolder = (treeOrWorkspace: string, folder: string): string =>
  `${safe(treeOrWorkspace)}/${folder.replace(/^\/work\/?/, '').split('/').filter((part) => part && part !== '.' && part !== '..').map(safe).join('/') || 'repo'}`;
