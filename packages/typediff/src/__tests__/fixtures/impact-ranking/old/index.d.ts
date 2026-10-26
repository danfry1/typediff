export type Status = 'active' | 'inactive'

export interface User {
  status: Status
}

export interface Account {
  status: Status
}

export declare function currentStatus(): Status

export declare const utils: {
  formatters: {
    pad: (value: string) => string
  }
}
