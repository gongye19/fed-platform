FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY --from=build /app/dist ./dist
CMD ["npm", "start"]
