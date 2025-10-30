# Changelog

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
