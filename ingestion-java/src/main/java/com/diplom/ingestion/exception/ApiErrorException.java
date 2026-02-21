package com.diplom.ingestion.exception;

import java.util.Map;

public class ApiErrorException extends RuntimeException {
    private final String code;
    private final int status;
    private final Map<String, Object> details;

    public ApiErrorException(String code, String message, int status, Map<String, Object> details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
    }

    public String getCode() {
        return code;
    }

    public int getStatus() {
        return status;
    }

    public Map<String, Object> getDetails() {
        return details;
    }
}
