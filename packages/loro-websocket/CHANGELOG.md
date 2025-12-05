# Changelog

## [0.4.3](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.4.2...loro-websocket-v0.4.3) (2025-12-05)


### Bug Fixes

* refine websocket client reconnect ([#31](https://github.com/loro-dev/protocol/issues/31)) ([d130f42](https://github.com/loro-dev/protocol/commit/d130f424384252e62ab02b9cff06a35ec75be59c))

## [0.4.2](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.4.1...loro-websocket-v0.4.2) (2025-11-28)


### Bug Fixes

* flock adaptor should only upload updates made by the current peer ([70dc0c6](https://github.com/loro-dev/protocol/commit/70dc0c6cf62d7d590e6e879c39726b42773752b4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-adaptors bumped to 0.4.2

## [0.4.1](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.4.0...loro-websocket-v0.4.1) (2025-11-22)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-adaptors bumped to 0.4.1

## [0.4.0](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.3.1...loro-websocket-v0.4.0) (2025-11-20)


### ⚠ BREAKING CHANGES

* enforce to use string for room-id ([#27](https://github.com/loro-dev/protocol/issues/27))
* Introduce subpath exports and remove server-registry abstraction in loro-adaptors ([#25](https://github.com/loro-dev/protocol/issues/25))

### Bug Fixes

* enforce to use string for room-id ([#27](https://github.com/loro-dev/protocol/issues/27)) ([2eeea76](https://github.com/loro-dev/protocol/commit/2eeea7663827070cf88bb4354c89187d59df53b2))


### Code Refactoring

* Introduce subpath exports and remove server-registry abstraction in loro-adaptors ([#25](https://github.com/loro-dev/protocol/issues/25)) ([d5f2460](https://github.com/loro-dev/protocol/commit/d5f2460cd78ab63c11a8f216af13bf6aed49fc91))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.2.0
    * loro-adaptors bumped to 0.4.0

## [0.3.1](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.3.0...loro-websocket-v0.3.1) (2025-11-19)


### Features

* expose socket in LoroWebsocketClient ([37f3a90](https://github.com/loro-dev/protocol/commit/37f3a90d6f863c1857ef185b81050b90d3e7dac6))


### Bug Fixes

* backfill issue ([cd9f639](https://github.com/loro-dev/protocol/commit/cd9f639bb0c2ce4989ad6c17178e78263540d007))
* turn tsdown hash=false to mk build correct ([b2036d5](https://github.com/loro-dev/protocol/commit/b2036d5ef4fe99531603556061549670e022e72b))
* we should call ephemeral destroy before free ([#24](https://github.com/loro-dev/protocol/issues/24)) ([43d7502](https://github.com/loro-dev/protocol/commit/43d7502e206dfbf954d913548d29ac15340728e2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-adaptors bumped to 0.3.1

## [0.3.0](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.2.1...loro-websocket-v0.3.0) (2025-11-11)


### ⚠ BREAKING CHANGES

* better api for server adaptor

### Code Refactoring

* better api for server adaptor ([a8f470b](https://github.com/loro-dev/protocol/commit/a8f470bd40857ee2e06e6db12648e5d5406de57d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-adaptors bumped to 0.3.0

## [0.2.1](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.2.0...loro-websocket-v0.2.1) (2025-11-05)


### Features

* Add persistent EphemeralStore adaptors ([#18](https://github.com/loro-dev/protocol/issues/18)) ([db6bfab](https://github.com/loro-dev/protocol/commit/db6bfab148ac2a513387bc7bc1b293a36ddb257f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.3
    * loro-adaptors bumped to 0.2.1

## [0.2.0](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.1.6...loro-websocket-v0.2.0) (2025-10-30)


### ⚠ BREAKING CHANGES

* simplify API

### Features

* integrate Flock support into Loro adaptors ([fc7d5c6](https://github.com/loro-dev/protocol/commit/fc7d5c6f0df26d1b7699b9f6e7f25addb648628a))


### Code Refactoring

* simplify API ([c0389a5](https://github.com/loro-dev/protocol/commit/c0389a5821e31b6dc89b8c755e319f8e70658641))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.2
    * loro-adaptors bumped to 0.2.0

## [0.1.6](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.1.5...loro-websocket-v0.1.6) (2025-10-23)


### Bug Fixes

* should not auto reconnect when kicked ([5272874](https://github.com/loro-dev/protocol/commit/5272874bf3a04c006b021c604ca54bb45d7ffb43))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-adaptors bumped to 0.1.3

## [0.1.5](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.1.4...loro-websocket-v0.1.5) (2025-10-23)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-adaptors bumped to 0.1.2

## [0.1.4](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.1.3...loro-websocket-v0.1.4) (2025-10-23)


### Features

* add server adaptor registry ([#9](https://github.com/loro-dev/protocol/issues/9)) ([ec73f3c](https://github.com/loro-dev/protocol/commit/ec73f3cfe7661844cb73ac2ab5124a6dae8b36d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.1
    * loro-adaptors bumped to 0.1.1

## [0.1.3](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.1.2...loro-websocket-v0.1.3) (2025-09-23)


### Bug Fixes

* rm isOnline to make retry connecting work ([e75769e](https://github.com/loro-dev/protocol/commit/e75769e4f9f9b136a8886356789d1dee6bc0f5a6))

## [0.1.2](https://github.com/loro-dev/protocol/compare/loro-websocket-v0.1.1...loro-websocket-v0.1.2) (2025-09-16)


### Bug Fixes

* use right status and auto retry after come back online ([fd1a67c](https://github.com/loro-dev/protocol/commit/fd1a67cd14e704110ee9faf090e372f753e68ab8))

## 0.1.0 (2025-09-12)


### Features

* add onWsClose callback to LoroWebsocketClient options ([#2](https://github.com/loro-dev/protocol/issues/2)) ([a7d7811](https://github.com/loro-dev/protocol/commit/a7d7811fdbf5430ef96811ea17cfdfad682a00c9))
* e2ee ([#1](https://github.com/loro-dev/protocol/issues/1)) ([6510fdd](https://github.com/loro-dev/protocol/commit/6510fdd4304b020f436f02b21fe96bad1681fe38))
* init repo ✨ ([a469149](https://github.com/loro-dev/protocol/commit/a469149b2c94e4496961df5a010ff98704545b4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.0
    * loro-adaptors bumped to 0.1.0
