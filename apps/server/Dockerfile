FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run prisma:generate --workspace @lumora/server
RUN npm run build --workspace @lumora/shared
RUN npm run build --workspace @lumora/server

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/apps/server/dist /app/apps/server/dist
COPY --from=build /app/apps/server/prisma /app/apps/server/prisma
COPY --from=build /app/apps/server/package.json /app/apps/server/package.json
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
