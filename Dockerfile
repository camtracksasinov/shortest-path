FROM node:20-alpine
WORKDIR /app
ENV TZ=Europe/Paris
RUN apk add --no-cache tzdata
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p downloads logs
CMD ["node", "src/report/schedule-report.js"]
