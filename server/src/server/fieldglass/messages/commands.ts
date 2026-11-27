import { execFile } from 'node:child_process';

export type MessagesCommand = '/usr/bin/sqlite3' | '/usr/bin/osascript' | '/bin/launchctl';
export type MessagesRunner = (file: MessagesCommand, args: string[], options: {
  signal: AbortSignal; maxBuffer: number;
}) => Promise<{ stdout: string; stderr?: string }>;

// No raw exec error escapes this adapter: its message includes argv, and argv
// includes private reply text. Neither stdout nor stderr is ever logged.
export const runMessagesCommand: MessagesRunner = (file, args, { signal, maxBuffer }) => new Promise((resolve, reject) => {
  execFile(file, args, { signal, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer,
    env: { ...process.env, LC_ALL: 'en_US.UTF-8' } }, (error, stdout) => {
    if (error) reject(new Error('Messages command did not complete'));
    else resolve({ stdout });
  });
});

// Verified against the installed Messages.sdef: chat.id is its GUID, chat has
// an account and participants, and send accepts a chat. Do not create a chat or
// choose the first available account. Recheck the exact target before sending.
export const SEND_SCRIPT = `on run argv
  if (count of argv) is not 4 then return "unavailable"
  set chatGuid to item 1 of argv
  set expectedService to item 2 of argv
  set expectedHandle to item 3 of argv
  set replyText to item 4 of argv
  tell application "Messages"
    try
      set targetChat to chat id chatGuid
      set actualService to service type of account of targetChat
      if expectedService is "iMessage" then
        if actualService is not iMessage then return "unavailable"
      else if expectedService is "SMS" then
        if actualService is not SMS then return "unavailable"
      else
        return "unavailable"
      end if
      set recipients to participants of targetChat
      if (count of recipients) is not 1 then return "unavailable"
      if (handle of item 1 of recipients) is not expectedHandle then return "unavailable"
    on error number errorNumber
      if errorNumber is -1743 then return "denied"
      return "unavailable"
    end try
    try
      send replyText to targetChat
      return "sent"
    on error number errorNumber
      if errorNumber is -1743 then return "denied"
      return "unknown"
    end try
  end tell
end run`;
