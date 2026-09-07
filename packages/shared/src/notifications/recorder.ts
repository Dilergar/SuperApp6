import { defineNotifications } from './types';

/** Диктофон и «Журнал звонков»: расшифровки и записи. `ref` = запись (`recording`). */
export const RECORDER_NOTIFICATIONS = defineNotifications({
  'voice.transcript.ready': { service: 'recorder', priority: 'normal', icon: 'mic', contexts: 'personal', collapse: 'ref' },
  'voice.transcript.failed': { service: 'recorder', priority: 'normal', icon: 'warning', contexts: 'personal', collapse: 'ref' },
  'call.recording.ready': { service: 'recorder', priority: 'normal', icon: 'record', contexts: 'personal', collapse: 'ref' },
  'call.recording.failed': { service: 'recorder', priority: 'normal', icon: 'warning', contexts: 'personal', collapse: 'ref' },
});
