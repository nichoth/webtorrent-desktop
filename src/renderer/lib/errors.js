import ExtendableError from 'es6-error'

/* Generic errors */

export class CastingError extends ExtendableError {}
export class PlaybackError extends ExtendableError {}
export class SoundError extends ExtendableError {}
export class TorrentError extends ExtendableError {}

/* Playback */

export class UnplayableTorrentError extends PlaybackError {
  constructor () { super('Can\'t play any files in torrent') }
}

export class UnplayableFileError extends PlaybackError {
  constructor () { super('Can\'t play that file') }
}

/* Sound */

export class InvalidSoundNameError extends SoundError {
  constructor (name) { super(`Invalid sound name: ${name}`) }
}

/* Torrent */

export class TorrentKeyNotFoundError extends TorrentError {
  constructor (torrentKey) { super(`Can't resolve torrent key ${torrentKey}`) }
}
