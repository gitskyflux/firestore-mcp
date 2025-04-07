#!/usr/bin/env node

/**
 * Cloud Firestore MCP Server
 * 
 * This server provides a Model Context Protocol interface for Google Cloud Firestore.
 * 
 * Environment variables:
 * - GOOGLE_CLOUD_PROJECTS: Comma-separated list of project-ids
 *   Example: "google-project-id1,google-project-id2"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { applicationDefault, cert } from "firebase-admin/app";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keysDir = path.resolve(__dirname, "..", "keys");

// Get Google projects from environment variable
const googleProjects = process.env.GOOGLE_CLOUD_PROJECTS ? 
    process.env.GOOGLE_CLOUD_PROJECTS.split(',').map(p => p.trim()) : 
    ["google-project-id1"];

// Initialize a map to store Firebase apps for each project
const firebaseApps: Record<string, admin.app.App> = {};
const firestoreInstances: Record<string, FirebaseFirestore.Firestore> = {};

// Helper function to handle Firestore timestamps properly
function transformTimestamps(obj: any): any {
    if (!obj) return obj;
    
    if (obj instanceof admin.firestore.Timestamp) {
        return obj; // Keep as Timestamp object for proper handling
    }
    
    // Check for timestamp-like objects (_seconds and _nanoseconds fields)
    if (obj && typeof obj === 'object' && 
        '_seconds' in obj && '_nanoseconds' in obj &&
        typeof obj._seconds === 'number' && typeof obj._nanoseconds === 'number') {
        return new admin.firestore.Timestamp(obj._seconds, obj._nanoseconds);
    }
    
    if (Array.isArray(obj)) {
        return obj.map(item => transformTimestamps(item));
    }
    
    if (typeof obj === 'object') {
        const result: Record<string, any> = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                result[key] = transformTimestamps(obj[key]);
            }
        }
        return result;
    }
    
    return obj;
}

// Function to get Firestore for a specific project
function getFirestoreForProject(projectId: string): FirebaseFirestore.Firestore {
    if (!firestoreInstances[projectId]) {
        throw new Error(`No Firestore instance initialized for project: ${projectId}`);
    }
    return firestoreInstances[projectId];
}

// Default project is the first one in the list
const defaultProject = googleProjects[0];

// Initialize Firebase Admin SDK for each project
for (const projectId of googleProjects) {
    try {
        // Construct key path based on project ID
        const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || 
                        path.resolve(keysDir, `${projectId}.json`);
        
        if (!fs.existsSync(keyPath)) {
            console.error(`Warning: No credentials file found for project ${projectId} at ${keyPath}`);
            continue;
        }
        
        // Read and parse the service account key file
        const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
        
        // Initialize Firebase app with a unique name (project ID)
        const app = admin.initializeApp({
            credential: cert(serviceAccount)
        }, projectId);
        
        firebaseApps[projectId] = app;
        firestoreInstances[projectId] = getFirestore(app);
        
        console.error(`Firebase Admin SDK initialized successfully for project: ${projectId}`);
    } catch (error) {
        console.error(`Error initializing Firebase Admin SDK for project ${projectId}:`, error);
    }
}

// Check if at least one project was successfully initialized
if (Object.keys(firestoreInstances).length === 0) {
    console.error("Error: Failed to initialize any Firebase projects. Exiting.");
    process.exit(1);
}

// Default Firestore instance (for backward compatibility)
const db = firestoreInstances[defaultProject];

// Create MCP server
const server = new Server(
    {
        name: "firestore",
        version: "1.0.0"
    },
    {
        capabilities: {
            tools: {
                listChanged: false
            },
            resources: {
                listChanged: false
            },
            prompts: {
                list: true,
                listChanged: false
            }
        }
    }
);

// Schema definitions
const CollectionDocumentSchema = z.object({
    collection: z.string().min(1),
    id: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
});

const CreateDocumentSchema = z.object({
    collection: z.string().min(1),
    data: z.record(z.any()),
    id: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
});

const UpdateDocumentSchema = z.object({
    collection: z.string().min(1),
    id: z.string().min(1),
    data: z.record(z.any()),
    merge: z.boolean().default(true),
    project: z.string().min(1).optional(),
});

const QueryDocumentsSchema = z.object({
    collection: z.string().min(1),
    filters: z.array(
        z.object({
            field: z.string().min(1),
            operator: z.enum(['==', '!=', '>', '<', '>=', '<=', 'array-contains', 'array-contains-any', 'in', 'not-in']),
            value: z.any()
        })
    ).optional(),
    orderBy: z.array(
        z.object({
            field: z.string().min(1),
            direction: z.enum(['asc', 'desc']).default('asc')
        })
    ).optional(),
    limit: z.number().positive().optional(),
    project: z.string().min(1).optional(),
});

const ListCollectionsSchema = z.object({
    project: z.string().min(1).optional(),
});

const ListPromptsSchema = z.object({
    collection: z.string().min(1).default("prompts"),
    project: z.string().min(1).optional(),
    limit: z.number().positive().optional(),
});

const EmptySchema = z.object({});

// Register resources/list handler
server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    // Here we could return actual resources if needed
    // For now, we'll return an empty list since this MCP primarily uses tools
    return {
        resources: [],
        cursor: null
    };
});

// Register custom prompts/list handler
server.setRequestHandler(
    z.object({
        method: z.literal("prompts/list"),
        params: z.object({}).optional()
    }),
    async (request) => {
        // Use the same logic as the listPrompts tool
        try {
            const collection = "prompts";
            const projectId = defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    prompts: []
                };
            }
            
            let query = projectDb.collection(collection);
            const querySnapshot = await query.get();
            
            if (querySnapshot.empty) {
                return {
                    prompts: []
                };
            }
            
            // Format the documents as proper prompt objects
            const prompts = querySnapshot.docs.map(doc => {
                // Transform data to handle timestamp conversion properly
                const rawData = doc.data();
                const data = transformTimestamps(rawData);
                
                return {
                    id: doc.id,
                    name: data.name || doc.id,
                    description: data.description || "",
                    text: data.text || data.content || "",
                    // Add any other fields that the client expects
                    metadata: {
                        createdAt: data.createdAt || null,
                        updatedAt: data.updatedAt || null,
                        tags: data.tags || [],
                        ...(data.metadata || {})
                    }
                };
            });
            
            return {
                prompts
            };
        } catch (error) {
            console.error("Error in prompts/list handler:", error);
            return {
                prompts: []
            };
        }
    }
);

// Register list tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "getDocument",
                description: "Get a single document from Firestore",
                inputSchema: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            description: "The Firestore collection name"
                        },
                        id: {
                            type: "string",
                            description: "The document ID to retrieve"
                        },
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        }
                    },
                    required: ["collection", "id"]
                }
            },
            {
                name: "createDocument",
                description: "Create a new document in Firestore",
                inputSchema: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            description: "The Firestore collection name"
                        },
                        data: {
                            type: "object",
                            description: "The document data to create"
                        },
                        id: {
                            type: "string",
                            description: "Optional document ID (will be auto-generated if not provided)"
                        },
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        }
                    },
                    required: ["collection", "data"]
                }
            },
            {
                name: "updateDocument",
                description: "Update an existing document in Firestore",
                inputSchema: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            description: "The Firestore collection name"
                        },
                        id: {
                            type: "string",
                            description: "The document ID to update"
                        },
                        data: {
                            type: "object",
                            description: "The document data to update"
                        },
                        merge: {
                            type: "boolean",
                            description: "Whether to merge the data with the existing document or overwrite it",
                            default: true
                        },
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        }
                    },
                    required: ["collection", "id", "data"]
                }
            },
            {
                name: "deleteDocument",
                description: "Delete a document from Firestore",
                inputSchema: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            description: "The Firestore collection name"
                        },
                        id: {
                            type: "string",
                            description: "The document ID to delete"
                        },
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        }
                    },
                    required: ["collection", "id"]
                }
            },
            {
                name: "queryDocuments",
                description: "Query documents from Firestore with filters, ordering, and limits",
                inputSchema: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            description: "The Firestore collection name"
                        },
                        filters: {
                            type: "array",
                            description: "An array of filter conditions",
                            items: {
                                type: "object",
                                properties: {
                                    field: {
                                        type: "string",
                                        description: "The document field to filter on"
                                    },
                                    operator: {
                                        type: "string",
                                        description: "The comparison operator",
                                        enum: ["==", "!=", ">", "<", ">=", "<=", "array-contains", "array-contains-any", "in", "not-in"]
                                    },
                                    value: {
                                        description: "The value to compare against"
                                    }
                                },
                                required: ["field", "operator", "value"]
                            }
                        },
                        orderBy: {
                            type: "array",
                            description: "An array of ordering directives",
                            items: {
                                type: "object",
                                properties: {
                                    field: {
                                        type: "string",
                                        description: "The document field to order by"
                                    },
                                    direction: {
                                        type: "string",
                                        description: "The sort direction",
                                        enum: ["asc", "desc"],
                                        default: "asc"
                                    }
                                },
                                required: ["field"]
                            }
                        },
                        limit: {
                            type: "number",
                            description: "The maximum number of documents to return",
                            minimum: 1
                        },
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        }
                    },
                    required: ["collection"]
                }
            },
            {
                name: "listCollections",
                description: "List all collections in the Firestore database",
                inputSchema: {
                    type: "object",
                    properties: {
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        }
                    }
                }
            },
            {
                name: "listProjects",
                description: "List all available Google project IDs that have been initialized",
                inputSchema: {
                    type: "object",
                    properties: {}
                }
            },
            {
                name: "listPrompts",
                description: "List all prompts stored in Firestore",
                inputSchema: {
                    type: "object",
                    properties: {
                        collection: {
                            type: "string",
                            description: "The Firestore collection containing prompts (defaults to 'prompts')",
                            default: "prompts"
                        },
                        project: {
                            type: "string",
                            description: "The Google project ID to use (optional, defaults to the first project in GOOGLE_CLOUD_PROJECTS)"
                        },
                        limit: {
                            type: "number",
                            description: "The maximum number of prompts to return",
                            minimum: 1
                        }
                    }
                }
            }
        ],
    };
});

// Register call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === "getDocument") {
            const { collection, id, project } = CollectionDocumentSchema.parse(args);
            
            if (!id) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: "Document ID is required" }, null, 2) 
                    }]
                };
            }
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            const docRef = projectDb.collection(collection).doc(id);
            const doc = await docRef.get();
            
            if (!doc.exists) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: "Document not found" }, null, 2) 
                    }]
                };
            }
            
            // Transform data to handle timestamp conversion properly
            const data = transformTimestamps(doc.data());
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify({ 
                        id: doc.id, 
                        ...data 
                    }, null, 2) 
                }]
            };
        }
        else if (name === "createDocument") {
            const { collection, data, id, project } = CreateDocumentSchema.parse(args);
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            // Transform input data to convert timestamp-like objects to real Firestore timestamps
            const transformedData = transformTimestamps(data);
            
            let docRef;
            let result;
            
            if (id) {
                docRef = projectDb.collection(collection).doc(id);
                await docRef.set(transformedData);
                result = { id, ...transformedData };
            } else {
                docRef = await projectDb.collection(collection).add(transformedData);
                result = { id: docRef.id, ...transformedData };
            }
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify(result, null, 2) 
                }]
            };
        }
        else if (name === "updateDocument") {
            const { collection, id, data, merge, project } = UpdateDocumentSchema.parse(args);
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            const docRef = projectDb.collection(collection).doc(id);
            const doc = await docRef.get();
            
            if (!doc.exists) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: "Document not found" }, null, 2) 
                    }]
                };
            }
            
            // Transform input data to convert timestamp-like objects to real Firestore timestamps
            const transformedData = transformTimestamps(data);
            
            await docRef.set(transformedData, { merge });
            
            // Get the updated document
            const updatedDoc = await docRef.get();
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify({ 
                        id: updatedDoc.id, 
                        ...updatedDoc.data() 
                    }, null, 2) 
                }]
            };
        }
        else if (name === "deleteDocument") {
            const { collection, id, project } = CollectionDocumentSchema.parse(args);
            
            if (!id) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: "Document ID is required" }, null, 2) 
                    }]
                };
            }
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            const docRef = projectDb.collection(collection).doc(id);
            const doc = await docRef.get();
            
            if (!doc.exists) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: "Document not found" }, null, 2) 
                    }]
                };
            }
            
            await docRef.delete();
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify({ 
                        success: true, 
                        message: `Document ${id} deleted from ${collection} in project ${projectId}` 
                    }, null, 2) 
                }]
            };
        }
        else if (name === "queryDocuments") {
            const { collection, filters, orderBy, limit, project } = QueryDocumentsSchema.parse(args);
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = projectDb.collection(collection);
            
            // Apply filters
            if (filters && filters.length > 0) {
                for (const filter of filters) {
                    query = query.where(filter.field, filter.operator as any, filter.value);
                }
            }
            
            // Apply ordering
            if (orderBy && orderBy.length > 0) {
                for (const order of orderBy) {
                    query = query.orderBy(order.field, order.direction);
                }
            }
            
            // Apply limit
            if (limit) {
                query = query.limit(limit);
            }
            
            const querySnapshot = await query.get();
            const documents = querySnapshot.docs.map(doc => {
                // Transform data to handle timestamp conversion properly
                const data = transformTimestamps(doc.data());
                return {
                    id: doc.id,
                    ...data
                };
            });
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify(documents, null, 2) 
                }]
            };
        }
        else if (name === "listCollections") {
            const { project } = ListCollectionsSchema.parse(args);
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            const collections = await projectDb.listCollections();
            const collectionNames = collections.map(collection => collection.id);
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify(collectionNames, null, 2) 
                }]
            };
        }
        else if (name === "listProjects") {
            EmptySchema.parse(args);
            
            // Return a list of all initialized projects
            const projects = Object.keys(firestoreInstances);
            
            // Include information about the default project
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify({
                        projects,
                        defaultProject,
                        currentEnv: process.env.GOOGLE_CLOUD_PROJECTS || "Not set",
                    }, null, 2) 
                }]
            };
        }
        else if (name === "listPrompts") {
            const { collection, limit, project } = ListPromptsSchema.parse(args);
            
            // Get the Firestore instance for the specified project or default
            const projectId = project || defaultProject;
            const projectDb = firestoreInstances[projectId] || db;
            
            if (!projectDb) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ error: `Project '${projectId}' not found or not initialized` }, null, 2) 
                    }]
                };
            }
            
            let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = projectDb.collection(collection);
            
            // Apply limit if specified
            if (limit) {
                query = query.limit(limit);
            }
            
            const querySnapshot = await query.get();
            
            if (querySnapshot.empty) {
                return {
                    content: [{ 
                        type: "text", 
                        text: JSON.stringify({ 
                            message: `No prompts found in collection '${collection}'`,
                            prompts: [] 
                        }, null, 2) 
                    }]
                };
            }
            
            const prompts = querySnapshot.docs.map(doc => {
                // Transform data to handle timestamp conversion properly
                const data = transformTimestamps(doc.data());
                return {
                    id: doc.id,
                    ...data
                };
            });
            
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify({
                        message: `Found ${prompts.length} prompts in collection '${collection}'`,
                        prompts
                    }, null, 2) 
                }]
            };
        }
        else {
            throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        if (error instanceof z.ZodError) {
            return {
                content: [{ 
                    type: "text", 
                    text: JSON.stringify({
                        error: "Invalid arguments",
                        details: error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")
                    }, null, 2)
                }]
            };
        }
        
        return {
            content: [{ 
                type: "text", 
                text: JSON.stringify({
                    error: "Internal server error",
                    message: (error as Error).message
                }, null, 2)
            }]
        };
    }
});

// Start the server
async function main() {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("Firestore MCP Server running on stdio");
    } catch (error) {
        console.error("Error during startup:", error);
        process.exit(1);
    }
}

main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});