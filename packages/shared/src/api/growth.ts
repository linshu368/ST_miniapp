export interface GrowthChannelLinkData {
  id: string;
  source_name: string;
  source_id: string;
  miniapp_link: string;
  tracking_link: string;
  status: 'active' | 'archived';
  notes: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  click_count: number;
  enter_count: number;
  unique_enter_count: number;
  activated_user_count: number;
  last_entered_at: string | null;
}

export interface GetGrowthChannelLinksData {
  links: GrowthChannelLinkData[];
}

export interface CreateGrowthChannelLinkRequest {
  source_name: string;
  source_id?: string;
  notes?: string;
}

export interface CreateGrowthChannelLinkData {
  link: GrowthChannelLinkData;
}

export interface RecordMiniappEntryRequest {
  source_id?: string;
  start_param?: string;
}

export interface RecordMiniappEntryData {
  recorded: boolean;
  source_id: string | null;
}
