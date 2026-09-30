FROM node:20-alpine
RUN apk add --no-cache python3 py3-pip && pip3 install --no-cache-dir pandas numpy requests
WORKDIR /app
COPY server/package*.json ./
RUN npm install
COPY server/ .
EXPOSE 3002
CMD ["node", "index.js"]
