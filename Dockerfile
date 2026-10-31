# AI OTC TRADER 3D — imagem de produção (sem dependências de runtime além do Node)
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
COPY scripts/backtest.ts ./scripts/backtest.ts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=8080 DB_PATH=/app/data/trader.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "backend/src/main.ts"]
