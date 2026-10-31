const { DatabaseSync } = require('node:sqlite')

class LibraryStore {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        album TEXT NOT NULL DEFAULT '',
        ext TEXT NOT NULL,
        format TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        duration REAL NOT NULL DEFAULT 0,
        mtime INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        source_root TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);
      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    try { this.db.exec("ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT ''") } catch { }
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(String(key), String(value))
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(String(key))
    return row ? row.value : null
  }

  replaceTracks(tracks) {
    const insert = this.db.prepare(`
      INSERT INTO tracks(id, path, url, title, artist, album, ext, format, size, duration, mtime, source, source_root, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        id = excluded.id,
        url = excluded.url,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        ext = excluded.ext,
        format = excluded.format,
        size = excluded.size,
        duration = excluded.duration,
        mtime = excluded.mtime,
        source = excluded.source,
        source_root = excluded.source_root,
        updated_at = excluded.updated_at
    `)
    const now = Date.now()
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM tracks')
      for (const track of tracks) {
        insert.run(
          track.id, track.path, track.url, track.title, track.artist, track.album,
          track.ext, track.format, track.size, track.duration, track.mtime,
          track.source || '', track.sourceRoot || '', now,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  all() {
    return this.db.prepare(`
      SELECT id, path, url, title, artist, album, ext, format, size, duration, mtime, source, source_root AS sourceRoot
      FROM tracks ORDER BY lower(title), lower(artist)
    `).all()
  }

  count() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM tracks').get()
    return row ? Number(row.count) : 0
  }

  close() {
    try { this.db.close() } catch { }
  }
}

module.exports = { LibraryStore }

