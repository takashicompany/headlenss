export type TodayEvent = { id: string; start: string; end: string; title: string; objective?: string };
export type SetupHelp = { connector: string; steps: string[] };
export type CalendarSource = 'google' | 'notion' | 'manual' | 'none';
export type GoogleConnector = 'google_calendar' | 'gmail' | 'google_drive';
export type GoogleProbes = Partial<Record<GoogleConnector, 'connected' | 'needs_auth'>>;
export type Today = {
  updatedAt: number | null; source: 'calendar' | 'manual' | 'none'; refreshing: boolean;
  events: TodayEvent[]; setup?: SetupHelp; lastError?: string; lastErrorKind?: JobErrorKind; lastSource: CalendarSource;
};
export type Followup = {
  id: string; quote: string; owner?: string; due?: string; eventId?: string; meetingTitle?: string;
  createdAt: number; expiresAt: number; sentTo?: string; sentAt?: number;
};
export type Connection = {
  id: string; name: string; status: 'connected' | 'needs_auth' | 'not_configured'; usedFor: string; steps: string[];
};
export type FieldTestEvent = {
  sessionId: string; cueId?: string;
  kind: 'cue_shown' | 'cue_retracted' | 'rated' | 'session_start' | 'session_end';
  lastWordAt?: number; candidateAt?: number; renderedAt?: number;
  category?: string; rating?: string; reason?: string; at: number;
};
export type FieldglassData = {
  version: 1;
  calendar: {
    updatedAt: number | null; day: string | null; source: 'calendar' | 'none'; events: TodayEvent[]; setup?: SetupHelp;
    lastError?: string; lastErrorKind?: JobErrorKind; lastSource: CalendarSource; googleProbes: GoogleProbes;
    retry: { failures: number; nextAttemptAt: number; authBlocked: boolean };
  };
  manualEvents: (TodayEvent & { day: string })[];
  manualUpdatedAt: number | null;
  lastSource: CalendarSource;
  objectives: Record<string, string>;
  followups: Followup[];
  connections: { updatedAt: number | null; connections: Connection[]; lastError?: string; lastErrorKind?: JobErrorKind };
  fieldtest: FieldTestEvent[];
};
import type { JobErrorKind } from './errors.ts';

