// Raindrop.io API Types

export interface Collection {
  _id: number;
  title: string;
  parent: { $id: number } | null;
  count: number;
  cover: string[];
  color: string;
  view: 'list' | 'simple' | 'grid' | 'masonry';
  sort: number;
  public: boolean;
  expanded: boolean;
  access: {
    level: number;
    draggable: boolean;
  };
  created: string;
  lastUpdate: string;
}

export interface CreateCollectionData {
  title: string;
  parent?: { $id: number };
  view?: 'list' | 'simple' | 'grid' | 'masonry';
  public?: boolean;
  sort?: number;
  cover?: string[];
}

export interface UpdateCollectionData {
  title?: string;
  parent?: { $id: number };
  view?: 'list' | 'simple' | 'grid' | 'masonry';
  public?: boolean;
  sort?: number;
  expanded?: boolean;
  cover?: string[];
}

export interface Raindrop {
  _id: number;
  link: string;
  title: string;
  excerpt: string;
  note: string;
  type: 'link' | 'article' | 'image' | 'video' | 'document' | 'audio';
  cover: string;
  tags: string[];
  important: boolean;
  removed: boolean;
  created: string;
  lastUpdate: string;
  domain: string;
  collection: { $id: number };
  highlights: Highlight[];
  media: Media[];
  user: { $id: number };
  sort: number;
}

export interface Highlight {
  _id: string;
  text: string;
  color: string;
  note: string;
  created: string;
}

export interface Media {
  link: string;
  type: string;
}

export interface CreateRaindropData {
  link: string;
  title?: string;
  excerpt?: string;
  note?: string;
  tags?: string[];
  important?: boolean;
  collection?: { $id: number };
  cover?: string;
  type?: 'link' | 'article' | 'image' | 'video' | 'document' | 'audio';
  pleaseParse?: { weight?: number };
}

export interface UpdateRaindropData {
  link?: string;
  title?: string;
  excerpt?: string;
  note?: string;
  tags?: string[];
  important?: boolean;
  collection?: { $id: number };
  cover?: string;
  removed?: boolean;
  order?: number;
}

export interface RaindropApiResponse<T> {
  result: boolean;
  item?: T;
  items?: T[];
  count?: number;
  collectionId?: number;
}

export interface CollectionsResponse {
  result: boolean;
  items: Collection[];
}

export interface RaindropsResponse {
  result: boolean;
  items: Raindrop[];
  count: number;
  collectionId: number;
}

