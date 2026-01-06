
export interface TranscriptionPart {
  text: string;
  sender: 'user' | 'model';
  timestamp: number;
}

export interface ClickAction {
  x: number;
  y: number;
  label: string;
  id: string;
}

export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR'
}
