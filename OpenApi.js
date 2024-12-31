function getOpenApiSpec() {
  const baseUrl = getDeployedWebAppUrl();

  // Define reusable schema for LogItem
  const logProperties = buildPropertiesSchema();

  const logItemSchema = {
    type: "object",
    properties: logProperties,
    description: "Represents a single log entry for tracking nutritional data."
  };

  const batchSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: { $ref: "#/components/schemas/LogItem" },
      description: "An array of LogItem objects for batch operations."
    }
  },
  required: ["items"],
  description: "An object containing an array of LogItem objects for batch operations."
};

  // Reusable endpoint details
  const getLogsDocs = {
    get: {
      operationId: "logs",
      summary: "Fetch logs",
      description: "Fetch log entries from the API. Use optional query parameters to filter by ID or date.",
      parameters: [
        {
          name: "id",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Filter logs by this ID."
        },
        {
          name: "date",
          in: "query",
          required: false,
          schema: { type: "string", format: "date" },
          description: "Filter logs by this date in YYYY-MM-DD format."
        }
      ],
      responses: {
        "200": {
          description: "Successful response with logs matching the criteria.",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: { $ref: "#/components/schemas/LogItem" }
              }
            }
          }
        }
      }
    }
  };

  const postLogDocs = {
    post: {
      operationId: "log",
      summary: "Create a single log entry",
      description: "Use POST to create a single log entry.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/LogItem" }
          }
        }
      },
      responses: {
        "201": {
          description: "Log created successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["created"] },
                  id: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  };

  const postLogsDocs = {
    post: {
      operationId: "logs",
      summary: "Create multiple log entries",
      description: "Use POST to create multiple log entries in a batch.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: batchSchema
          }
        }
      },
      responses: {
        "201": {
          description: "Logs created successfully.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        status: { type: "string", enum: ["created"] },
                        id: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  const summariesDocs = {
    get: {
      operationId: "summaries",
      summary: "Fetch summaries",
      description: "Retrieve summary data from the API.",
      responses: {
        "200": {
          description: "Successful response with summary data.",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    date: { type: "string", format: "date" },
                    totalCalories: { type: "number" },
                    totalProtein: { type: "number" },
                    totalFat: { type: "number" },
                    totalCarbs: { type: "number" }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  // Build the OpenAPI spec
  return {
    openapi: "3.1.0",
    info: {
      title: "Nutritional Tracking API",
      version: "1.0.1",
      description: "An API for tracking nutritional information, allowing CRUD operations on logs and summaries. Note: This API is designed to work with a Cloudflare Worker that rewrites URLs (e.g., `/logs` to `/?path=logs`)."
    },
    servers: [
      {
        url: baseUrl,
        description: "Main API server"
      }
    ],
    components: {
      schemas: {
        LogItem: logItemSchema
      }
    },
    paths: {
      "/": {
        get: {
          operationId: "getData",
          summary: "Fetch data from the API",
          description: "Use the `path` query parameter to select which data to fetch. For example, `?path=summaries` or `?path=logs`. For logs, you can also filter by `id` or `date` using `?id=<ID>` or `?date=<YYYY-MM-DD>`.",
          parameters: [
            {
              name: "path",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["summaries", "logs"] },
              description: "Specify 'summaries' to fetch summaries or 'logs' to fetch logs. If omitted, the OpenAPI spec is returned."
            },
            {
              name: "id",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "If path=logs, filter logs by this ID."
            },
            {
              name: "date",
              in: "query",
              required: false,
              schema: { type: "string", format: "date" },
              description: "If path=logs, filter logs by this date in YYYY-MM-DD format."
            }
          ],
          responses: {
            "200": {
              description: "Successful response. If no path specified, returns the OpenAPI spec. If path=summaries, returns summaries. If path=logs, returns logs."
            }
          }
        }
      },
      "/log": {
        ...postLogDocs
      },
      "/logs": {
        ...getLogsDocs,
        ...postLogsDocs
      },
      "/summaries": {
        ...summariesDocs
      }
    }
  };
}



/**
 * Dynamically build the properties schema from FIXED_FIELDS_SPEC and NUTRIENTS_SPEC.
 */
function buildPropertiesSchema() {
  const props = {};
  FIXED_FIELDS_SPEC.forEach(field => {
    props[field.name] = field.format ? 
      { type: field.type, format: field.format } : 
      { type: field.type };
  });
  NUTRIENTS_SPEC.forEach(nutrient => {
    props[nutrient.name] = { type: nutrient.type };
  });
  return props;
}