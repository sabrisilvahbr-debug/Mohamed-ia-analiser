// GERADO por scripts/build-frontend-lib.ts a partir de backend/src/settings.ts — não editar.
/**
 * Configurações operacionais persistidas no banco e validadas no backend.
 * Nenhum valor aqui é dado de mercado: são parâmetros escolhidos pelo usuário.
 */
                                                       
                                                        
                                           

                               
                                                                         
                           
                                                                                        
                       
                                                                
                           
                                                    
                      
                                                                           
                               
                                                           
                          
                                                                 
                            
 

                           
                 
                       
                           
                             
                
                               
                                      
                                                        
                                                                                                
                           
                           
                     
 

export const DEFAULT_SETTINGS           = {
  symbol: 'R_100',
  strategy: 'ema_cross',
  contractDuration: 5,
  durationUnit: 't',
  stake: 1,
  executionMode: 'signals',
  ema: { fast: 9, slow: 21 },
  rsi: { period: 14, lower: 30, upper: 70 },
  minVolatilityPct: 0,
  maxVolatilityPct: 0,
  risk: {
    maxStakePerTrade: 5,
    maxDailyLoss: 20,
    maxOpenContracts: 1,
    maxExposure: 5,
    maxConsecutiveLosses: 3,
    cooldownSeconds: 30,
    maxTickAgeSeconds: 10,
  },
};

export class ValidationError extends Error {
           issues          ;
  constructor(issues          ) {
    super('Configuração inválida: ' + issues.join('; '));
    this.issues = issues;
  }
}

function isObj(v         )                               {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(issues          , name        , v         , min        , max        , integer = false)         {
  if (typeof v !== 'number' || !Number.isFinite(v)) { issues.push(`${name} deve ser número`); return min; }
  if (integer && !Number.isInteger(v)) issues.push(`${name} deve ser inteiro`);
  if (v < min || v > max) issues.push(`${name} deve estar entre ${min} e ${max}`);
  return v;
}

/** Mescla um patch parcial nas configurações atuais e valida o resultado completo. */
export function mergeAndValidate(current          , patch         )           {
  if (!isObj(patch)) throw new ValidationError(['corpo deve ser um objeto JSON']);
  const allowedTop = new Set(Object.keys(DEFAULT_SETTINGS));
  const unknownKeys = Object.keys(patch).filter((k) => !allowedTop.has(k));
  if (unknownKeys.length) throw new ValidationError([`campos desconhecidos: ${unknownKeys.join(', ')}`]);

  const merged           = {
    ...current,
    ...(patch                     ),
    ema: { ...current.ema, ...(isObj(patch.ema) ? (patch.ema          ) : {}) },
    rsi: { ...current.rsi, ...(isObj(patch.rsi) ? (patch.rsi          ) : {}) },
    risk: { ...current.risk, ...(isObj(patch.risk) ? (patch.risk          ) : {}) },
  };
  return validateSettings(merged);
}

export function validateSettings(s          )           {
  const issues           = [];
  if (typeof s.symbol !== 'string' || !/^\w{2,30}$/.test(s.symbol)) issues.push('symbol inválido (padrão ^\\w{2,30}$ da Deriv)');
  if (s.strategy !== 'ema_cross' && s.strategy !== 'rsi_reversion') issues.push('strategy deve ser ema_cross ou rsi_reversion');
  if (!['t', 's', 'm'].includes(s.durationUnit)) issues.push('durationUnit deve ser t, s ou m');
  num(issues, 'contractDuration', s.contractDuration, 1, 3600, true);
  num(issues, 'stake', s.stake, 0.35, 100000);
  if (!['signals', 'demo', 'real'].includes(s.executionMode)) issues.push('executionMode deve ser signals, demo ou real');
  num(issues, 'ema.fast', s.ema.fast, 2, 200, true);
  num(issues, 'ema.slow', s.ema.slow, 3, 500, true);
  if (s.ema.fast >= s.ema.slow) issues.push('ema.fast deve ser menor que ema.slow');
  num(issues, 'rsi.period', s.rsi.period, 2, 200, true);
  num(issues, 'rsi.lower', s.rsi.lower, 1, 49);
  num(issues, 'rsi.upper', s.rsi.upper, 51, 99);
  num(issues, 'minVolatilityPct', s.minVolatilityPct, 0, 100);
  num(issues, 'maxVolatilityPct', s.maxVolatilityPct, 0, 100);
  if (s.maxVolatilityPct > 0 && s.minVolatilityPct > s.maxVolatilityPct) issues.push('minVolatilityPct > maxVolatilityPct');
  const r = s.risk;
  num(issues, 'risk.maxStakePerTrade', r.maxStakePerTrade, 0.35, 100000);
  num(issues, 'risk.maxDailyLoss', r.maxDailyLoss, 0.35, 1000000);
  num(issues, 'risk.maxOpenContracts', r.maxOpenContracts, 1, 20, true);
  num(issues, 'risk.maxExposure', r.maxExposure, 0.35, 1000000);
  num(issues, 'risk.maxConsecutiveLosses', r.maxConsecutiveLosses, 1, 50, true);
  num(issues, 'risk.cooldownSeconds', r.cooldownSeconds, 0, 86400, true);
  num(issues, 'risk.maxTickAgeSeconds', r.maxTickAgeSeconds, 1, 300, true);
  if (s.stake > r.maxStakePerTrade) issues.push('stake maior que risk.maxStakePerTrade');
  if (issues.length) throw new ValidationError(issues);
  return s;
}
