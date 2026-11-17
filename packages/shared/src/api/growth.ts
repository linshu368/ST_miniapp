/** Legacy fields remain accepted; attribution trusts only signed Telegram start_param. */
export interface RecordMiniappEntryRequest {
  source_id?: string;
  start_param?: string;
}
export interface RecordMiniappEntryData {
  recorded: boolean;
  source_id: string | null;
  eligibility?: 'new' | 'existing' | 'unknown';
  converted?: boolean;
}
export type RecordMujianEntryData = RecordMiniappEntryData;
