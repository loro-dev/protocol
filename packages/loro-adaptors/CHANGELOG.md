# Changelog

## [0.5.0](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.4.2...loro-adaptors-v0.5.0) (2025-12-07)


### ⚠ BREAKING CHANGES

* protocol v1 ([#34](https://github.com/loro-dev/protocol/issues/34))

### Features

* protocol v1 ([#34](https://github.com/loro-dev/protocol/issues/34)) ([6570a2e](https://github.com/loro-dev/protocol/commit/6570a2eef0ab73729242adea21052390c39409b3))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.3.0

## [0.4.2](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.4.1...loro-adaptors-v0.4.2) (2025-11-28)


### Bug Fixes

* flock adaptor should only upload updates made by the current peer ([70dc0c6](https://github.com/loro-dev/protocol/commit/70dc0c6cf62d7d590e6e879c39726b42773752b4))

## [0.4.1](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.4.0...loro-adaptors-v0.4.1) (2025-11-22)


### Bug Fixes

* use oplog version ([5d556c5](https://github.com/loro-dev/protocol/commit/5d556c5491e0655bb7d10f57686c81510c34dfdb))

## [0.4.0](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.3.1...loro-adaptors-v0.4.0) (2025-11-20)


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

## [0.3.1](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.3.0...loro-adaptors-v0.3.1) (2025-11-19)


### Bug Fixes

* we should call ephemeral destroy before free ([#24](https://github.com/loro-dev/protocol/issues/24)) ([43d7502](https://github.com/loro-dev/protocol/commit/43d7502e206dfbf954d913548d29ac15340728e2))

## [0.3.0](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.2.1...loro-adaptors-v0.3.0) (2025-11-11)


### ⚠ BREAKING CHANGES

* better api for server adaptor

### Code Refactoring

* better api for server adaptor ([a8f470b](https://github.com/loro-dev/protocol/commit/a8f470bd40857ee2e06e6db12648e5d5406de57d))

## [0.2.1](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.2.0...loro-adaptors-v0.2.1) (2025-11-05)


### Features

* Add persistent EphemeralStore adaptors ([#18](https://github.com/loro-dev/protocol/issues/18)) ([db6bfab](https://github.com/loro-dev/protocol/commit/db6bfab148ac2a513387bc7bc1b293a36ddb257f))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.3

## [0.2.0](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.1.3...loro-adaptors-v0.2.0) (2025-10-30)


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

## [0.1.3](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.1.2...loro-adaptors-v0.1.3) (2025-10-23)


### Bug Fixes

* server adaptor bug ([8b48b4b](https://github.com/loro-dev/protocol/commit/8b48b4b684ceeb02322cb6ad36b2f5c75cac7a7d))

## [0.1.2](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.1.1...loro-adaptors-v0.1.2) (2025-10-23)


### Bug Fixes

* refine server adaptor api and fix a loro mem leak ([41d5f3e](https://github.com/loro-dev/protocol/commit/41d5f3e8fadf203a1e1c67e9eb87c26839141e98))

## [0.1.1](https://github.com/loro-dev/protocol/compare/loro-adaptors-v0.1.0...loro-adaptors-v0.1.1) (2025-10-23)


### Features

* add server adaptor registry ([#9](https://github.com/loro-dev/protocol/issues/9)) ([ec73f3c](https://github.com/loro-dev/protocol/commit/ec73f3cfe7661844cb73ac2ab5124a6dae8b36d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.1

## 0.1.0 (2025-09-12)


### Features

* e2ee ([#1](https://github.com/loro-dev/protocol/issues/1)) ([6510fdd](https://github.com/loro-dev/protocol/commit/6510fdd4304b020f436f02b21fe96bad1681fe38))
* init repo ✨ ([a469149](https://github.com/loro-dev/protocol/commit/a469149b2c94e4496961df5a010ff98704545b4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * loro-protocol bumped to 0.1.0
