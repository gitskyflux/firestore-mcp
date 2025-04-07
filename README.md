# Firestore MCP Server

An MCP (Model Context Protocol) server for interacting with Google Firestore directly. This server provides a clean interface for creating, reading, updating, and deleting Firestore documents through Claude Desktop.

## Features

- Create documents in Firestore collections
- Read documents from Firestore collections
- Update existing documents
- Delete documents
- Query documents with filtering, ordering, and limits
- List available collections

## Setup

1. **Install dependencies**:
   ```
   npm install
   ```

2. **Build the project**:
   ```
   npm run build
   ```

3. **Configure Claude Desktop**:
   Add the following to your `claude_desktop_config.json`:

   ```json
   "firestore-mcp": {
     "command": "node",
     "args": [
       "/path/to/firestore-mcp/build/index.js"
     ],
     "env": {
       "GOOGLE_CLOUD_PROJECTS": "project-id"
     }
   }
   ```

   Replace the path in args with the actual path to index.js.

   Define a comma-separated list of project ids in GOOGLE_CLOUD_PROJECTS.
   Example: `google-project-id1,google-project-id2`
   The first listed project is the default.

   The application expects to find .json credential file(s) in the keys folder for each project.
   Example: keys/google-project-id1.json, keys/google-project-id2.json
   Ensure the cloud service account has appropriate permission to interact with Cloud Firestore, e.g. `Cloud Datastore Owner` or lesser permission(s).

## Available Tools

- **getDocument**: Get a document by ID from a collection
- **createDocument**: Create a new document in a collection
- **updateDocument**: Update an existing document
- **deleteDocument**: Delete a document
- **queryDocuments**: Query documents with filters, ordering, and limits
- **listCollections**: List all available collections

## Example Usage in Claude Desktop

Here are examples of how to use each tool in Claude Desktop:

### Get a Document

```
Get the document with ID "user123" from the "users" collection
```

### Create a Document

```
Create a new document in the "users" collection with the following data:
{
  "name": "John Doe",
  "email": "john@example.com",
  "age": 30
}
```

### Update a Document

```
Update the document with ID "user123" in the "users" collection to change the age to 31
```

### Delete a Document

```
Delete the document with ID "user123" from the "users" collection
```

### Query Documents

```
Find all users over 25 years old, ordered by name
```

### List Collections

```
List all available Firestore collections
```

## Development

- **Watch mode**: `npm run dev`