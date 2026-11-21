FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --omit=optional
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
