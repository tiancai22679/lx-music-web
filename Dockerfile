# lx-music-web —— 纯 Node 运行，零 npm 依赖
FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY parsers.js ./
COPY lxsource.js ./
COPY sources ./sources
COPY web ./web
ENV PORT=3005
EXPOSE 3005
CMD ["node", "server.js"]
