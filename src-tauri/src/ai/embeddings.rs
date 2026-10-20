//! Local deterministic embeddings with a sqlite-vec-compatible storage contract.
//!
//! This is an offline baseline rather than a semantic model: Unicode character
//! n-grams are hashed into a small normalized vector. It makes the index useful
//! without network/model setup and keeps the storage/query contract replaceable
//! when a model-backed embedding provider is added later.

use rusqlite::{Connection, OptionalExtension, params};

pub const VECTOR_DIMENSION: usize = 64;

pub fn embed_text(text: &str) -> Vec<f32> {
    let normalized = text.trim().to_lowercase();
    let characters = normalized.chars().collect::<Vec<_>>();
    let mut vector = vec![0.0_f32; VECTOR_DIMENSION];

    for width in 1..=3 {
        if characters.len() < width {
            continue;
        }
        for window in characters.windows(width) {
            let mut hash = 2_166_136_261_u32;
            for character in window {
                for byte in (*character as u32).to_le_bytes() {
                    hash ^= u32::from(byte);
                    hash = hash.wrapping_mul(16_777_619);
                }
            }
            let index = (hash as usize) % VECTOR_DIMENSION;
            let sign = if hash & 1 == 0 { 1.0 } else { -1.0 };
            vector[index] += sign * (1.0 / width as f32);
        }
    }

    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for value in &mut vector {
            *value /= norm;
        }
    } else {
        vector[0] = 1.0;
    }
    vector
}

pub fn vector_json(vector: &[f32]) -> Result<String, String> {
    if vector.len() != VECTOR_DIMENSION || vector.iter().any(|value| !value.is_finite()) {
        return Err(format!("向量必须是 {} 个有限浮点数", VECTOR_DIMENSION));
    }
    serde_json::to_string(vector).map_err(|error| format!("无法序列化向量：{error}"))
}

pub fn cosine_similarity(left: &[f32], right: &[f32]) -> Option<f32> {
    if left.len() != VECTOR_DIMENSION || right.len() != VECTOR_DIMENSION {
        return None;
    }
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if left_norm <= f32::EPSILON || right_norm <= f32::EPSILON {
        return None;
    }
    Some(
        left.iter()
            .zip(right)
            .map(|(left, right)| left * right)
            .sum::<f32>()
            / (left_norm * right_norm),
    )
}

pub fn upsert_note_embedding(
    connection: &Connection,
    path: &str,
    content_hash: &str,
    title: &str,
    content: &str,
    updated_at: &str,
) -> Result<(), String> {
    let vector = vector_json(&embed_text(&format!("{title}\n{content}")))?;
    connection
        .execute(
            "INSERT INTO note_embeddings (note_path, content_hash, dimension, embedding, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(note_path) DO UPDATE SET
               content_hash = excluded.content_hash,
               dimension = excluded.dimension,
               embedding = excluded.embedding,
               updated_at = excluded.updated_at",
            params![path, content_hash, VECTOR_DIMENSION as i64, vector, updated_at],
        )
        .map_err(|error| format!("无法写入向量元数据：{error}"))?;
    Ok(())
}

pub fn remove_note_embedding(connection: &Connection, path: &str) -> Result<(), String> {
    let id = connection
        .query_row(
            "SELECT id FROM note_embeddings WHERE note_path = ?1",
            params![path],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("无法读取待删除向量：{error}"))?;
    if let Some(id) = id {
        connection
            .execute("DELETE FROM note_embeddings WHERE id = ?1", params![id])
            .map_err(|error| format!("无法删除向量元数据：{error}"))?;
    }
    Ok(())
}

pub fn backfill(connection: &Connection) -> Result<(), String> {
    let rows = {
        let mut statement = connection
            .prepare("SELECT path, content_hash, title, content, indexed_at FROM notes")
            .map_err(|error| format!("无法读取向量补建数据：{error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| format!("无法枚举向量补建数据：{error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("无法读取向量补建数据：{error}"))?
    };
    for (path, hash, title, content, indexed_at) in rows {
        let current_hash = connection
            .query_row(
                "SELECT content_hash FROM note_embeddings WHERE note_path = ?1",
                params![path],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("无法读取向量哈希：{error}"))?;
        if current_hash.as_deref() != Some(hash.as_str()) {
            upsert_note_embedding(connection, &path, &hash, &title, &content, &indexed_at)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{VECTOR_DIMENSION, cosine_similarity, embed_text, vector_json};

    #[test]
    fn embedding_is_deterministic_and_normalized() {
        let first = embed_text("权限过滤与检索");
        assert_eq!(first, embed_text("权限过滤与检索"));
        assert_eq!(first.len(), VECTOR_DIMENSION);
        let norm = first.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 0.0001);
    }

    #[test]
    fn vector_json_rejects_wrong_dimension() {
        assert!(vector_json(&[1.0]).is_err());
    }

    #[test]
    fn cosine_similarity_rejects_empty_or_wrong_dimension_vectors() {
        assert!(cosine_similarity(&[], &[]).is_none());
        assert!(cosine_similarity(&vec![1.0; VECTOR_DIMENSION], &[1.0]).is_none());
        assert!(
            cosine_similarity(&vec![1.0; VECTOR_DIMENSION], &vec![1.0; VECTOR_DIMENSION]).is_some()
        );
    }
}
