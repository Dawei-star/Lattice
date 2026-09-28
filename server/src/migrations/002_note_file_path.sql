-- Persist the source-relative Markdown path so equal titles cannot overwrite one another.
ALTER TABLE notes ADD COLUMN file_path TEXT;

CREATE UNIQUE INDEX ux_notes_file_path ON notes (file_path) WHERE file_path IS NOT NULL AND file_path <> '';
