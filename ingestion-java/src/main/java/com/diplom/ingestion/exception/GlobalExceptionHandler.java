package com.diplom.ingestion.exception;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.HashMap;
import java.util.Map;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ApiErrorException.class)
    public ResponseEntity<Map<String, Object>> handleApiError(ApiErrorException exception) {
        Map<String, Object> error = new HashMap<>();
        error.put("code", exception.getCode());
        error.put("message", exception.getMessage());
        error.put("details", exception.getDetails() == null ? Map.of() : exception.getDetails());

        Map<String, Object> body = Map.of("error", error);
        return ResponseEntity.status(exception.getStatus()).body(body);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> handleUnexpected(Exception exception) {
        Map<String, Object> error = new HashMap<>();
        error.put("code", "INTERNAL_ERROR");
        error.put("message", "Unexpected ingestion failure");
        error.put("details", Map.of("reason", exception.getMessage()));

        Map<String, Object> body = Map.of("error", error);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }
}
