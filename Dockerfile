## Simple Dockerfile to build ReactMap (main branch)
# - Inside the container, the content of this git repo lives in /home/node/
## You have to mount your configs into the container:
# - mount local.json to /home/node/server/src/configs/local.json
# - mount areas.json to /home/node/server/src/configs/areas.json
# - Also mount every other configuration file necessary into the according directory.

FROM node:22.23.1-alpine AS build

ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=$PATH:/home/node/.npm-global/bin

WORKDIR /home/node
RUN apk add --no-cache git \
  && npm install -g yarn

COPY package.json yarn.lock ./
COPY packages ./packages
COPY config ./config
RUN yarn install --frozen-lockfile

COPY . .
RUN yarn build
RUN yarn install --production --frozen-lockfile --ignore-scripts

FROM node:22.23.1-alpine AS runtime

ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=$PATH:/home/node/.npm-global/bin

WORKDIR /home/node
RUN apk add --no-cache git
COPY --from=build /home/node ./
