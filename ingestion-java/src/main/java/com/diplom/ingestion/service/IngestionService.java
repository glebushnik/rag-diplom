package com.diplom.ingestion.service;

import com.diplom.ingestion.dto.*;
import com.diplom.ingestion.exception.ApiErrorException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;

@Service
public class IngestionService {
    private final JdbcTemplate jdbcTemplate;
    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    @Value("${services.parser-url}")
    private String parserUrl;

    @Value("${services.embedding-url}")
    private String embeddingUrl;

    @Value("${services.retrieval-url}")
    private String retrievalUrl;

    @Value("${security.internal-token:}")
    private String internalToken;

    @Value("${ingestion.raw-storage-dir}")
    private String rawStorageDir;

    public IngestionService(JdbcTemplate jdbcTemplate, RestTemplate restTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.restTemplate = restTemplate;
        this.objectMapper = objectMapper;
    }

    public IngestResponse ingest(MultipartFile file,
                                 UUID sourceId,
                                 UUID documentId,
                                 UUID userId,
                                 String sourceType,
                                 String requestId) {
        UUID resolvedSourceId = sourceId == null ? UUID.randomUUID() : sourceId;
        UUID resolvedDocumentId = documentId == null ? UUID.randomUUID() : documentId;
        UUID jobId = UUID.randomUUID();

        String originalFilename = file.getOriginalFilename() == null ? "document" : file.getOriginalFilename();
        String safeFilename = originalFilename.replaceAll("[^a-zA-Z0-9._-]", "_");
        Path storagePath = Paths.get(rawStorageDir, resolvedDocumentId + "_" + safeFilename);

        upsertSource(resolvedSourceId, userId, sourceType, originalFilename, "queued");
        upsertDocument(resolvedDocumentId, resolvedSourceId, originalFilename, storagePath.toString(), "queued");
        insertJob(jobId, resolvedSourceId, "queued", null);

        try {
            Files.createDirectories(storagePath.getParent());
            file.transferTo(storagePath);

            updateStatuses(jobId, resolvedSourceId, resolvedDocumentId, "processing", null);

            ParseResponse parseResponse = callParser(file, requestId);
            List<StoredChunk> storedChunks = persistChunks(resolvedDocumentId, parseResponse);
            setDocumentStatus(resolvedDocumentId, "parsed");

            EmbedResponse embedResponse = callEmbedding(storedChunks, resolvedDocumentId, requestId);
            updateStatuses(jobId, resolvedSourceId, resolvedDocumentId, "embedded", null);

            callRetrievalIndex(resolvedSourceId, storedChunks, embedResponse, requestId);
            updateStatuses(jobId, resolvedSourceId, resolvedDocumentId, "indexed", null);

            return new IngestResponse(jobId, resolvedSourceId, resolvedDocumentId, "indexed");
        } catch (ApiErrorException exception) {
            updateStatuses(jobId, resolvedSourceId, resolvedDocumentId, "failed", exception.getMessage());
            throw exception;
        } catch (Exception exception) {
            updateStatuses(jobId, resolvedSourceId, resolvedDocumentId, "failed", exception.getMessage());
            throw new ApiErrorException(
                    "INGEST_FAILED",
                    "Ingestion pipeline failed",
                    500,
                    Map.of("jobId", jobId.toString(), "reason", exception.getMessage())
            );
        }
    }

    public JobStatusResponse getJobStatus(UUID jobId) {
        List<JobStatusResponse> rows = jdbcTemplate.query(
                "SELECT id, source_id, status, error FROM jobs WHERE id = ?",
                (resultSet, rowNum) -> new JobStatusResponse(
                        UUID.fromString(resultSet.getString("id")),
                        UUID.fromString(resultSet.getString("source_id")),
                        resultSet.getString("status"),
                        resultSet.getString("error")
                ),
                jobId
        );

        if (rows.isEmpty()) {
            throw new ApiErrorException("JOB_NOT_FOUND", "Job not found", 404, Map.of("jobId", jobId.toString()));
        }

        return rows.get(0);
    }

    private ParseResponse callParser(MultipartFile file, String requestId) {
        try {
            HttpHeaders headers = baseHeaders(requestId);
            headers.setContentType(MediaType.MULTIPART_FORM_DATA);

            MultiValueMap<String, Object> body = new LinkedMultiValueMap<>();
            body.add("file", new FilenameByteArrayResource(file.getBytes(), file.getOriginalFilename()));

            HttpEntity<MultiValueMap<String, Object>> entity = new HttpEntity<>(body, headers);
            ResponseEntity<ParseResponse> response = restTemplate.exchange(
                    parserUrl + "/parse",
                    HttpMethod.POST,
                    entity,
                    ParseResponse.class
            );

            ParseResponse payload = response.getBody();
            if (payload == null || payload.chunks() == null || payload.chunks().isEmpty()) {
                throw new ApiErrorException("PARSER_EMPTY", "Parser returned no chunks", 422, Map.of());
            }

            return payload;
        } catch (HttpStatusCodeException exception) {
            throw new ApiErrorException(
                    "PARSER_FAILED",
                    "Parser service returned an error",
                    502,
                    Map.of("status", exception.getStatusCode().value(), "body", exception.getResponseBodyAsString())
            );
        } catch (IOException exception) {
            throw new ApiErrorException(
                    "FILE_READ_FAILED",
                    "Failed to read uploaded file",
                    400,
                    Map.of("reason", exception.getMessage())
            );
        }
    }

    private EmbedResponse callEmbedding(List<StoredChunk> chunks, UUID documentId, String requestId) {
        List<EmbedChunk> payloadChunks = chunks.stream()
                .map(chunk -> new EmbedChunk(
                        chunk.chunkId,
                        documentId,
                        chunk.index,
                        chunk.text,
                        chunk.lang,
                        chunk.tokenCount,
                        chunk.metadata
                ))
                .toList();

        EmbedRequest payload = new EmbedRequest(null, payloadChunks);

        try {
            HttpHeaders headers = baseHeaders(requestId);
            headers.setContentType(MediaType.APPLICATION_JSON);

            ResponseEntity<EmbedResponse> response = restTemplate.exchange(
                    embeddingUrl + "/embed",
                    HttpMethod.POST,
                    new HttpEntity<>(payload, headers),
                    EmbedResponse.class
            );

            EmbedResponse body = response.getBody();
            if (body == null || body.embeddings() == null || body.embeddings().isEmpty()) {
                throw new ApiErrorException("EMBEDDING_EMPTY", "Embedding service returned no vectors", 502, Map.of());
            }

            return body;
        } catch (HttpStatusCodeException exception) {
            throw new ApiErrorException(
                    "EMBEDDING_FAILED",
                    "Embedding service returned an error",
                    502,
                    Map.of("status", exception.getStatusCode().value(), "body", exception.getResponseBodyAsString())
            );
        }
    }

    private void callRetrievalIndex(UUID sourceId,
                                    List<StoredChunk> chunks,
                                    EmbedResponse embeddings,
                                    String requestId) {
        List<IndexChunk> indexChunks = chunks.stream()
                .map(chunk -> new IndexChunk(chunk.chunkId, chunk.documentId, chunk.index, chunk.text, chunk.metadata))
                .toList();

        IndexRequest payload = new IndexRequest(sourceId, embeddings.embeddings(), indexChunks);

        try {
            HttpHeaders headers = baseHeaders(requestId);
            headers.setContentType(MediaType.APPLICATION_JSON);

            ResponseEntity<Map> response = restTemplate.exchange(
                    retrievalUrl + "/index",
                    HttpMethod.POST,
                    new HttpEntity<>(payload, headers),
                    Map.class
            );

            if (!response.getStatusCode().is2xxSuccessful()) {
                throw new ApiErrorException(
                        "INDEXING_FAILED",
                        "Retrieval indexing failed",
                        502,
                        Map.of("status", response.getStatusCode().value())
                );
            }
        } catch (HttpStatusCodeException exception) {
            throw new ApiErrorException(
                    "INDEXING_FAILED",
                    "Retrieval service returned an error",
                    502,
                    Map.of("status", exception.getStatusCode().value(), "body", exception.getResponseBodyAsString())
            );
        }
    }

    private List<StoredChunk> persistChunks(UUID documentId, ParseResponse parseResponse) {
        jdbcTemplate.update("DELETE FROM chunks WHERE document_id = ?", documentId);

        List<StoredChunk> stored = new ArrayList<>();
        for (ParseChunk chunk : parseResponse.chunks()) {
            UUID chunkId = UUID.randomUUID();
            String language = chunk.lang() == null || chunk.lang().isBlank() ? "ru" : chunk.lang();
            int tokenCount = chunk.tokenCount() > 0 ? chunk.tokenCount() : chunk.text().split("\\s+").length;

            String metadataJson;
            try {
                metadataJson = objectMapper.writeValueAsString(chunk.metadata() == null ? Map.of() : chunk.metadata());
            } catch (JsonProcessingException exception) {
                metadataJson = "{}";
            }

            jdbcTemplate.update(
                    """
                    INSERT INTO chunks (id, document_id, chunk_index, text, token_count, metadata, lang)
                    VALUES (?, ?, ?, ?, ?, CAST(? AS jsonb), ?)
                    """,
                    chunkId,
                    documentId,
                    chunk.index(),
                    chunk.text(),
                    tokenCount,
                    metadataJson,
                    language
            );

            stored.add(new StoredChunk(
                    chunkId,
                    documentId,
                    chunk.index(),
                    chunk.text(),
                    language,
                    tokenCount,
                    chunk.metadata() == null ? Map.of() : chunk.metadata()
            ));
        }

        if (stored.isEmpty()) {
            throw new ApiErrorException("NO_CHUNKS", "No chunks were generated for document", 422, Map.of());
        }

        return stored;
    }

    private void upsertSource(UUID sourceId, UUID userId, String sourceType, String name, String status) {
        jdbcTemplate.update(
                """
                INSERT INTO sources (id, user_id, type, name, status)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                    user_id = COALESCE(EXCLUDED.user_id, sources.user_id),
                    type = EXCLUDED.type,
                    name = EXCLUDED.name,
                    status = EXCLUDED.status,
                    updated_at = NOW()
                """,
                sourceId,
                userId,
                sourceType,
                name,
                status
        );
    }

    private void upsertDocument(UUID documentId, UUID sourceId, String filename, String storagePath, String status) {
        jdbcTemplate.update(
                """
                INSERT INTO documents (id, source_id, filename, storage_path, status)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                    source_id = EXCLUDED.source_id,
                    filename = EXCLUDED.filename,
                    storage_path = EXCLUDED.storage_path,
                    status = EXCLUDED.status,
                    updated_at = NOW()
                """,
                documentId,
                sourceId,
                filename,
                storagePath,
                status
        );
    }

    private void insertJob(UUID jobId, UUID sourceId, String status, String error) {
        jdbcTemplate.update(
                "INSERT INTO jobs (id, source_id, status, error) VALUES (?, ?, ?, ?)",
                jobId,
                sourceId,
                status,
                error
        );
    }

    private void updateStatuses(UUID jobId, UUID sourceId, UUID documentId, String status, String error) {
        jdbcTemplate.update(
                "UPDATE jobs SET status = ?, error = ?, updated_at = NOW() WHERE id = ?",
                status,
                error,
                jobId
        );

        jdbcTemplate.update(
                "UPDATE sources SET status = ?, updated_at = NOW() WHERE id = ?",
                status,
                sourceId
        );

        String documentStatus = switch (status) {
            case "embedded" -> "embedded";
            case "indexed" -> "indexed";
            case "failed" -> "failed";
            case "processing" -> "processing";
            default -> "processing";
        };

        jdbcTemplate.update(
                "UPDATE documents SET status = ?, updated_at = NOW() WHERE id = ?",
                documentStatus,
                documentId
        );
    }

    private void setDocumentStatus(UUID documentId, String status) {
        jdbcTemplate.update(
                "UPDATE documents SET status = ?, updated_at = NOW() WHERE id = ?",
                status,
                documentId
        );
    }

    private HttpHeaders baseHeaders(String requestId) {
        HttpHeaders headers = new HttpHeaders();
        if (requestId != null && !requestId.isBlank()) {
            headers.add("X-Request-Id", requestId);
        }
        if (internalToken != null && !internalToken.isBlank()) {
            headers.add("X-Internal-Token", internalToken);
        }
        return headers;
    }

    private static class FilenameByteArrayResource extends ByteArrayResource {
        private final String filename;

        FilenameByteArrayResource(byte[] byteArray, String filename) {
            super(byteArray);
            this.filename = filename == null ? "document" : filename;
        }

        @Override
        public String getFilename() {
            return filename;
        }
    }

    private static class StoredChunk {
        private final UUID chunkId;
        private final UUID documentId;
        private final int index;
        private final String text;
        private final String lang;
        private final int tokenCount;
        private final Map<String, Object> metadata;

        private StoredChunk(UUID chunkId,
                            UUID documentId,
                            int index,
                            String text,
                            String lang,
                            int tokenCount,
                            Map<String, Object> metadata) {
            this.chunkId = chunkId;
            this.documentId = documentId;
            this.index = index;
            this.text = text;
            this.lang = lang;
            this.tokenCount = tokenCount;
            this.metadata = metadata;
        }
    }
}
