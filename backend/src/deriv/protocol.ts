/**
 * Tipos das mensagens da API Options da Deriv, transcritos dos JSON Schemas oficiais
 * publicados em https://developers.deriv.com/schemas/*.schema.json (consultados em 31/10/2026).
 * Apenas os campos usados pelo sistema estão tipados; o restante é ignorado.
 */

export interface DerivErrorBody { code?: string; message?: string; details?: unknown }

export interface BaseResponse {
  msg_type: string;
  echo_req: Record<string, unknown>;
  req_id?: number;
  subscription?: { id: string };
  error?: DerivErrorBody;
  /** Formato de erro REST/handshake ({ errors: [{ status, code, message }] }). */
  errors?: { status?: number; code?: string; message?: string }[];
}

export interface ActiveSymbol {
  exchange_is_open: 0 | 1;
  is_trading_suspended: 0 | 1;
  market: string;
  pip_size: number;
  subgroup: string;
  submarket: string;
  trade_count: number;
  underlying_symbol: string;
  underlying_symbol_name: string;
  underlying_symbol_type: string;
}
export interface ActiveSymbolsResponse extends BaseResponse { msg_type: 'active_symbols'; active_symbols: ActiveSymbol[] }

export interface Tick { ask?: number; bid?: number; quote: number; epoch: number; symbol: string; id?: string; pip_size: number }
export interface TickResponse extends BaseResponse { msg_type: 'tick'; tick?: Tick }

export interface TicksHistoryResponse extends BaseResponse {
  msg_type: 'history' | 'candles' | 'tick' | 'ohlc';
  history?: { prices: number[]; times: number[] };
  pip_size?: number;
}

export interface ContractAvailable {
  barriers: number;
  contract_category: string;
  contract_type: string;
  expiry_type: string;
  market: string;
  max_contract_duration: string;
  min_contract_duration: string;
  sentiment: string;
  submarket: string;
  underlying_symbol: string;
  payout_limit?: number;
}
export interface ContractsForResponse extends BaseResponse { msg_type: 'contracts_for'; contracts_for?: { available: ContractAvailable[]; hit_count?: number } }

export interface ProposalRequest {
  proposal: 1;
  amount: number;
  basis: 'stake' | 'payout';
  contract_type: string;
  currency: string;
  duration: number;
  duration_unit: 't' | 's' | 'm' | 'h' | 'd';
  underlying_symbol: string;
}
export interface ProposalResponse extends BaseResponse {
  msg_type: 'proposal';
  proposal?: { id: string; ask_price: number; payout: number; spot: number; spot_time: number; date_start: number; longcode: string };
}

export interface BuyResponse extends BaseResponse {
  msg_type: 'buy';
  buy?: {
    balance_after: number; buy_price: number; contract_id: number; longcode: string; payout: number;
    purchase_time: number; shortcode: string; start_time: number; transaction_id: number;
  };
}

export interface OpenContract {
  contract_id: number;
  status: 'open' | 'sold' | 'won' | 'lost' | 'cancelled' | null;
  is_sold: 0 | 1;
  is_expired?: 0 | 1;
  is_settleable?: 0 | 1;
  profit: string | number;
  buy_price: string | number;
  sell_price?: string | number | null;
  payout?: string | number;
  bid_price?: string | number;
  entry_spot?: string | number | null;
  exit_spot?: string | number | null;
  underlying_symbol?: string;
  contract_type?: string;
  currency?: string;
  date_start?: number;
  sell_time?: number | null;
  transaction_ids?: { buy?: number; sell?: number };
}
export interface ProposalOpenContractResponse extends BaseResponse { msg_type: 'proposal_open_contract'; proposal_open_contract?: OpenContract }

export interface BalanceResponse extends BaseResponse { msg_type: 'balance'; balance?: { balance: number; currency: string; id?: string; loginid: string } }

export interface StatementTransaction {
  action_type: string; amount: number; app_id: string | null; balance_after: number; contract_id: number | null;
  longcode?: string; payout?: number | null; shortcode?: string | null; transaction_id: number; transaction_time: number;
}
export interface StatementResponse extends BaseResponse { msg_type: 'statement'; statement?: { count?: number; transactions: StatementTransaction[] } }

/** Converte campos numéricos que a Deriv envia como string (ex.: profit, buy_price). */
export function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
