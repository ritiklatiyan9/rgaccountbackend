import { exportBackup } from './backup.service.js';
import { attachmentReferences,exportAttachmentParts } from './backupAttachmentParts.js';

export async function exportBackupSet(db,input,{onProgress=()=>{},publish,attachmentOptions={}}) {
  const deadline=Date.now()+30*60*1000;
  const progress=value=>{
    if(Date.now()>deadline) throw Object.assign(new Error('Backup preparation exceeded 30 minutes. The set was not completed.'),{statusCode:408});
    onProgress(value);
  };
  let records=await exportBackup(db,input,{onProgress:progress,separateAttachments:true});
  const refs=attachmentReferences(records.payload.tables);
  const context={backupId:records.payload.backupId,recordsChecksum:records.checksum,month:records.payload.month};
  await publish({buffer:records.buffer,checksum:records.checksum,filename:records.filename,kind:'records'});
  // Do not retain the database row objects while streaming attachment chunks.
  records=null;
  const result=await exportAttachmentParts(refs,context,{...attachmentOptions,onProgress:progress,publish});
  return {multipart:true,backupId:context.backupId,...result};
}
