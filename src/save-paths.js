// Normalize Windows verbatim paths for comparisons, without changing Unix case.
export function normalizedSavePath(value){let p=String(value||'').replace(/\\/g,'/');if(p.startsWith('//?/UNC/'))p='//'+p.slice(8);else if(p.startsWith('//?/'))p=p.slice(4);return p.replace(/\/+$/,'');}
const windows=p=>/^[a-z]:\//i.test(p)||p.startsWith('//');
export function savePathIdentity(value){const p=normalizedSavePath(value);return windows(p)?p.toLowerCase():p;}
export function isUnderSaveFolder(value,folder){const p=savePathIdentity(value),root=savePathIdentity(folder);return !!root&&(p===root||p.startsWith(root+'/'));}
export function rebaseSavePath(value,oldFolder,newFolder){if(!value||!isUnderSaveFolder(value,oldFolder))return value;return normalizedSavePath(newFolder)+normalizedSavePath(value).slice(normalizedSavePath(oldFolder).length);}
