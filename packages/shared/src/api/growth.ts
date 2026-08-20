export interface RecordMiniappEntryRequest {
  source_id?: string;
  start_param?: string;
}

export interface RecordMiniappEntryData {
  recorded: boolean;
  source_id: string | null;
}
