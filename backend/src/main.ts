import { hasDerivCredentials, loadDotEnv, readConfig, secretValues } from './config.ts';
import { Store } from './db.ts';
import { logger, registerSecret } from './logger.ts';
import { Supervisor } from './agents/supervisor.ts';
import { createServer } from './server.ts';

const log = logger('main');

loadDotEnv();
const cfg = readConfig();
for (const s of secretValues(cfg)) registerSecret(s);

const store = new Store(cfg.dbPath);

// Lock de instância única: impede dois motores operando o mesmo banco (ex.: após reinício/deploy).
if (!store.acquireLock()) {
  log.error('Outra instância do motor está ativa neste banco. Encerrando para evitar ordens duplicadas.');
  process.exit(1);
}
const lockTimer = setInterval(() => {
  if (!store.acquireLock()) {
    log.error('Lock de instância perdido — encerrando.');
    process.exit(1);
  }
}, 10_000);

const sup = new Supervisor({ config: cfg, store });
const server = createServer(cfg, store, sup);

server.listen(cfg.port, () => {
  log.info(`AI OTC TRADER 3D ouvindo na porta ${cfg.port}`, {
    adminToken: cfg.adminToken ? 'configurado' : 'AUSENTE',
    derivCredentials: hasDerivCredentials(cfg) ? 'configuradas' : 'ausentes (somente dados públicos)',
    allowRealTrading: cfg.allowRealTrading,
  });
  sup.start();
});

let closing = false;
async function shutdown(sig: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`${sig} recebido — encerrando com segurança`);
  sup.audit.record('info', 'supervisor', 'shutdown', `Servidor encerrando (${sig}). Contratos abertos continuam na Deriv e serão reacompanhados no próximo início.`);
  await sup.shutdown();
  clearInterval(lockTimer);
  server.close();
  store.releaseLock();
  store.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('unhandledRejection', (e) => log.error('promessa rejeitada sem tratamento', e));
