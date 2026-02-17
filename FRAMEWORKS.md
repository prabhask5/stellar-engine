# stellar-drive -- Frameworks & Libraries

The `stellar-drive` package is an offline-first, local-first sync engine for web applications. It handles bidirectional synchronization between a local IndexedDB database and a remote Supabase PostgreSQL backend, using intent-based operations, operation coalescing, and three-tier conflict resolution. The engine is designed to be consumed by any frontend application; Svelte integration is provided as an optional peer dependency.

This document explains each underlying technology from scratch, assuming no prior knowledge, and then describes how stellar-drive uses it.

---

## Table of Contents

1. [IndexedDB (Browser Database)](#1-indexeddb-browser-database)
2. [Dexie.js (IndexedDB Wrapper)](#2-dexiejs-indexeddb-wrapper)
3. [Supabase (Backend-as-a-Service)](#3-supabase-backend-as-a-service)
4. [Svelte (UI Framework)](#4-svelte-ui-framework)
5. [SvelteKit (Application Framework)](#5-sveltekit-application-framework)
6. [Yjs (CRDT Library)](#6-yjs-crdt-library)

---

## 1. IndexedDB (Browser Database)

### What is IndexedDB?

IndexedDB is a full NoSQL database built into every modern web browser. When you open Chrome, Firefox, Safari, or Edge, there is already a complete database engine running inside it -- you do not need to install anything. Every website or web application can create its own database that lives on the user's device, completely separate from the server.

Think of it like having a local SQLite database, but inside the browser.

### How IndexedDB Differs from localStorage

You may have heard of `localStorage`, which is a simpler key-value store in the browser. IndexedDB is fundamentally different:

| Feature | localStorage | IndexedDB |
|---------|-------------|-----------|
| Data types | Strings only | Any JavaScript object (objects, arrays, dates, blobs, files) |
| Storage limit | ~5-10 MB | Typically 50% of available disk space (can be gigabytes) |
| Querying | Get by key only | Indexes, ranges, cursors for complex queries |
| Transactions | No | Yes -- atomic read-write operations |
| Async/Sync | Synchronous (blocks the page) | Asynchronous (non-blocking) |
| Structured data | Must JSON.stringify everything | Stores objects natively |

### Key Concepts

**Object Stores** are like tables in a SQL database. Each object store holds a collection of records. For example, you might have a `tasks` object store that holds all your task records, and a `projects` object store that holds all your projects. You define object stores when you create the database.

**Keys** are the primary identifier for each record in an object store, like a primary key in SQL. Every record must have a unique key. Keys can be auto-generated (auto-incrementing numbers) or you can provide your own (like UUIDs).

**Indexes** allow fast lookups on fields other than the primary key. Without an index, finding all tasks where `completed === true` would require scanning every record. With an index on `completed`, the database can jump directly to the matching records. You create indexes when you define the object store.

**Transactions** group multiple operations into an atomic unit. Either all operations in a transaction succeed, or they all fail and the database rolls back to its previous state. This prevents corrupted or partial data. For example, if you need to write to two tables simultaneously, a transaction ensures both writes happen or neither does.

**Cursors** let you iterate over the results of a query one record at a time. This is useful when you have many records and do not want to load them all into memory at once.

### Why IndexedDB is Asynchronous

IndexedDB is fully asynchronous, meaning operations do not block the browser's main thread. When you ask IndexedDB to read or write data, it returns immediately and notifies you when the operation is complete (via callbacks or events). This is critical because the browser's main thread also handles user interactions, animations, and rendering. If a database read took 100ms and blocked the main thread, the page would freeze for 100ms -- buttons would not respond, animations would stutter.

The raw IndexedDB API uses a request/event pattern:

```javascript
const request = objectStore.get('some-key');
request.onsuccess = (event) => {
  const result = event.target.result;
  // use result here
};
request.onerror = (event) => {
  // handle error
};
```

### Storage Limits

IndexedDB storage limits are browser-dependent, but modern browsers typically allow a site to use up to 50% of the available disk space. On a device with 100 GB free, that is potentially 50 GB of IndexedDB storage. This is far more than localStorage's 5-10 MB limit.

### When Data is Cleared

IndexedDB data persists across browser restarts, system reboots, and updates. It is **not** cleared when the user closes the browser. However, it can be lost in two situations:

1. The user manually clears browser data (Settings > Clear Browsing Data).
2. The browser evicts data under extreme storage pressure (very low disk space). Browsers use a "best-effort" policy for storage and may evict the least-recently-used site's data. You can prevent this by requesting **persistent storage** via the Storage API (`navigator.storage.persist()`), which tells the browser to keep this site's data even under pressure.

### Why Dexie.js is Needed (Raw IndexedDB Example)

Here is what it looks like to add a single record using the raw IndexedDB API:

```javascript
// Open (or create) a database
const openRequest = indexedDB.open('MyDatabase', 1);

openRequest.onupgradeneeded = (event) => {
  const db = event.target.result;
  // Create an object store with an auto-incrementing key
  const store = db.createObjectStore('tasks', { keyPath: 'id' });
  // Create an index on the 'completed' field
  store.createIndex('by_completed', 'completed');
};

openRequest.onsuccess = (event) => {
  const db = event.target.result;

  // Start a read-write transaction
  const transaction = db.transaction('tasks', 'readwrite');
  const store = transaction.objectStore('tasks');

  // Add a record
  const addRequest = store.add({
    id: 'task-1',
    name: 'Buy groceries',
    completed: false
  });

  addRequest.onsuccess = () => {
    console.log('Task added successfully');
  };

  addRequest.onerror = () => {
    console.error('Failed to add task');
  };

  transaction.oncomplete = () => {
    console.log('Transaction finished');
  };
};

openRequest.onerror = () => {
  console.error('Failed to open database');
};
```

That is over 30 lines of nested callbacks just to add one record. Querying, updating, and managing schema versions are even more verbose. This is why virtually every application that uses IndexedDB does so through a wrapper library like Dexie.js.

### How stellar-drive Uses IndexedDB

- **All reads come from IndexedDB.** The UI never queries the remote server directly. Every piece of data displayed in the app is read from the local IndexedDB database, which makes reads instant regardless of network conditions.
- **All writes go to IndexedDB first.** When the user creates or edits a record, it is written to IndexedDB immediately (no network wait). A corresponding sync queue entry is enqueued in the same transaction, guaranteeing that a background push will eventually ship the change to the server.
- **Five internal system tables** live in IndexedDB alongside app data: `syncQueue` (pending outbound operations), `conflictHistory` (field-level conflict resolution records), `offlineCredentials` (cached user credentials for offline sign-in), `offlineSession` (offline session tokens), and `singleUserConfig` (single-user gate configuration).
- **Recovery via delete-and-rebuild.** If the IndexedDB database is corrupted or has mismatched object stores (e.g., from a stale service worker), the engine deletes the entire database and recreates it from scratch. Data is rehydrated from Supabase on the next sync cycle.

---

## 2. Dexie.js (IndexedDB Wrapper)

### What is Dexie.js?

Dexie.js is a minimalist, Promise-based wrapper around IndexedDB. It takes the verbose, callback-heavy raw IndexedDB API and replaces it with a clean, modern API that supports `async`/`await`, method chaining, and intuitive query syntax. The name "Dexie" is short for "IndexedDB" (inDeXiEdb).

### Why Dexie Exists

As shown in the IndexedDB section above, the raw API requires deeply nested callbacks, manual transaction management, and verbose event handling. Dexie solves all of this:

```javascript
// Raw IndexedDB: ~35 lines of nested callbacks
// Dexie: 1 line
await db.tasks.add({ id: 'task-1', name: 'Buy groceries', completed: false });
```

### Key Concepts

#### Database Creation

You create a Dexie database by instantiating the class and declaring your schema:

```javascript
import Dexie from 'dexie';

const db = new Dexie('MyAppDatabase');

db.version(1).stores({
  tasks: 'id, completed, created_at',
  projects: 'id, name'
});
```

The `new Dexie('MyAppDatabase')` creates (or opens) a database named "MyAppDatabase". The `.version(1).stores({...})` call declares what object stores (tables) exist and what indexes they have.

#### Schema Declaration (String-Based Index Syntax)

Dexie uses a compact string syntax to declare indexes. The string lists the primary key first, followed by any secondary indexes, separated by commas:

| Syntax | Meaning | Example |
|--------|---------|---------|
| `'id'` | `id` is the primary key | `tasks: 'id'` |
| `'++id'` | `id` is auto-incrementing | `logs: '++id, timestamp'` |
| `'&email'` | `email` must be unique | `users: 'id, &email'` |
| `'name'` | Non-unique index on `name` | `tasks: 'id, name, completed'` |
| `'[firstName+lastName]'` | Compound index | `users: 'id, [firstName+lastName]'` |

Important: the schema string only declares the **primary key and indexes**. You can store any fields you want on the objects -- only indexed fields need to be listed. An object with 20 fields only needs to list the 3-4 fields you want to query by.

#### CRUD Operations

Dexie provides intuitive methods for Create, Read, Update, and Delete:

```javascript
// CREATE -- add a new record (fails if key already exists)
await db.tasks.add({ id: 'task-1', name: 'Buy groceries', completed: false });

// READ -- get a single record by primary key
const task = await db.tasks.get('task-1');

// UPDATE -- put replaces the entire record (upsert: insert or update)
await db.tasks.put({ id: 'task-1', name: 'Buy groceries', completed: true });

// DELETE -- remove by primary key
await db.tasks.delete('task-1');

// BULK OPERATIONS -- efficient batch writes
await db.tasks.bulkPut([
  { id: 'task-1', name: 'Task one', completed: false },
  { id: 'task-2', name: 'Task two', completed: false },
  { id: 'task-3', name: 'Task three', completed: true }
]);
```

#### Queries

Dexie provides a fluent query API for filtering and sorting:

```javascript
// Exact match on an indexed field
const completedTasks = await db.tasks.where('completed').equals(true).toArray();

// Range queries
const recentTasks = await db.tasks.where('created_at').above('2024-01-01').toArray();
const rangeTasks = await db.tasks.where('priority').between(1, 5).toArray();

// Get all records from a table
const allTasks = await db.tasks.toArray();

// Count records
const count = await db.tasks.where('completed').equals(false).count();

// Filter with a function (works on non-indexed fields too, but slower)
const filtered = await db.tasks.filter(task => task.name.includes('grocery')).toArray();
```

The `.where()` method uses indexes for fast lookups. The `.filter()` method scans all records, so it works on any field but is slower for large datasets.

#### Transactions

Dexie transactions ensure atomicity -- either all operations succeed or none do:

```javascript
await db.transaction('rw', [db.tasks, db.syncQueue], async () => {
  // Both of these must succeed, or both roll back
  await db.tasks.add({ id: 'task-1', name: 'New task', completed: false });
  await db.syncQueue.add({ table: 'tasks', entityId: 'task-1', operationType: 'create' });

  // If this line throws, BOTH writes above are rolled back
  if (someCondition) throw new Error('Abort!');
});
```

The `'rw'` means read-write mode. The array `[db.tasks, db.syncQueue]` lists which tables the transaction touches. If any operation inside the callback throws an error, the entire transaction is automatically rolled back.

#### Table References

You can access tables in two ways:

```javascript
// Dot notation (convenient, only works if table name is a valid JavaScript identifier)
await db.tasks.get('task-1');

// Method call (works for any table name, including those with special characters)
await db.table('tasks').get('task-1');
```

#### Version Upgrades

When your app evolves and you need to add tables or indexes, you bump the version number:

```javascript
const db = new Dexie('MyAppDatabase');

// Original schema
db.version(1).stores({
  tasks: 'id, completed'
});

// Add a new 'projects' table and a new index on tasks
db.version(2).stores({
  tasks: 'id, completed, projectId',
  projects: 'id, name'
});

// Data migration: populate a new field on existing records
db.version(3).stores({
  tasks: 'id, completed, projectId, priority'
}).upgrade(async tx => {
  // Set default priority for all existing tasks
  await tx.table('tasks').toCollection().modify(task => {
    task.priority = task.priority ?? 3;
  });
});
```

Dexie handles the migration automatically when the database is opened. Each version only needs to declare the tables/indexes that **changed** -- unchanged tables are carried forward.

### How stellar-drive Uses Dexie

- **Auto-creates and manages the Dexie instance** via `initEngine()`. Consumer apps do not need to create their own Dexie database; the engine creates it based on the provided schema configuration:

```typescript
initEngine({
  prefix: 'myapp',
  schema: {
    tasks: 'project_id, order',
    settings: { singleton: true },
  },
  auth: { gateType: 'code', codeLength: 6 },
});
```

- **System tables auto-merged** into every schema version. The engine requires five internal tables (`syncQueue`, `offlineCredentials`, `offlineSession`, `singleUserConfig`, `conflictHistory`) and automatically adds them to the consumer's schema definition. Consumers never declare these.
- **System indexes auto-appended** to every user table: `id`, `user_id`, `created_at`, `updated_at`, `deleted`, `_version`. These are required for sync, conflict resolution, and soft-delete filtering. A schema entry like `tasks: 'project_id, order'` becomes the Dexie index string `'id, user_id, created_at, updated_at, deleted, _version, project_id, order'`.
- **Automatic version management.** The engine hashes the merged store schema, compares it to a localStorage-persisted hash, and bumps the Dexie version number only when the schema actually changes. When upgrading, it declares both the previous and current version so Dexie has a proper upgrade path.
- **All CRUD operations go through Dexie transactions.** Every local write is paired with a sync queue entry inside a single transaction, guaranteeing that if the data is written locally, a sync operation is always queued for it.
- **Snake-to-camel table name conversion.** Supabase table names are snake_case (`goal_lists`), but Dexie table names are auto-converted to camelCase (`goalLists`) for JavaScript-idiomatic access.

---

## 3. Supabase (Backend-as-a-Service)

### What is Supabase?

Supabase is an open-source alternative to Firebase. It provides a complete backend for your application -- database, authentication, real-time subscriptions, file storage, and auto-generated APIs -- all built on top of PostgreSQL, the world's most advanced open-source relational database.

Instead of building your own server, writing your own authentication system, designing your own API, and managing your own database, you can point your frontend directly at Supabase and get all of these out of the box. Supabase is self-hostable, meaning you can run it on your own server instead of using their hosted service.

### Key Services

#### PostgreSQL Database

At the core of Supabase is a full PostgreSQL database. PostgreSQL is a relational database, meaning data is organized into tables with columns and rows, similar to a spreadsheet but far more powerful:

```sql
-- A table definition in PostgreSQL
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  name TEXT NOT NULL,
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

PostgreSQL supports:
- **Tables** with typed columns (text, numbers, booleans, dates, JSON, arrays)
- **Foreign keys** that link tables together (a task belongs to a project)
- **Joins** that combine data from multiple tables in a single query
- **Constraints** that enforce data integrity (required fields, unique values)
- **Functions and triggers** that run custom logic inside the database

#### Authentication

Supabase provides a complete authentication system out of the box:

- **Email/password** -- traditional signup and login
- **OAuth providers** -- "Sign in with Google/GitHub/etc."
- **Magic links** -- passwordless login via email link
- **OTP verification** -- one-time passcode sent via email or SMS
- **Session management** -- JWTs (JSON Web Tokens) with automatic refresh

When a user signs up, Supabase creates a record in its internal `auth.users` table and returns a session token. This token is sent with every subsequent request to identify the user.

**How JWTs work:** A JWT (JSON Web Token) is a signed string that contains the user's identity (their UUID, email, etc.). The server generates and signs it with a secret key. On every API request, the client sends this token in the `Authorization` header. The server verifies the signature to confirm the token has not been tampered with, then extracts the user's ID without needing a database lookup. JWTs expire after a configurable duration (typically 1 hour), and Supabase automatically refreshes them using a separate refresh token.

#### Realtime

Supabase Realtime uses WebSockets to push database changes to connected clients instantly. A WebSocket is a persistent, two-way connection between the browser and server (unlike HTTP, which is request-response). When a record is inserted, updated, or deleted in the database, Supabase broadcasts the change to all subscribed clients within milliseconds.

Supabase Realtime has three modes:

- **Postgres Changes** -- subscribe to INSERT, UPDATE, DELETE events on specific tables. The server watches PostgreSQL's write-ahead log and pushes changes to subscribed clients.
- **Broadcast** -- a pub/sub channel not tied to database tables. Any client can publish a message, and all other clients on the same channel receive it. Useful for ephemeral data like cursor positions or CRDT document updates.
- **Presence** -- tracks which users are currently connected to a channel. Each client can share arbitrary state (like their cursor position), and all clients receive join/leave events. Useful for "who's online" features.

#### Row Level Security (RLS)

RLS is a PostgreSQL feature that restricts which rows a user can see or modify, enforced at the database level. This is more secure than application-level access control because even if someone bypasses your frontend code, the database itself refuses unauthorized access:

```sql
-- Policy: users can only see their own tasks
CREATE POLICY "Users see own tasks" ON tasks
  FOR SELECT
  USING (user_id = auth.uid());

-- Policy: users can only insert tasks for themselves
CREATE POLICY "Users insert own tasks" ON tasks
  FOR INSERT
  WITH CHECK (user_id = auth.uid());
```

`auth.uid()` is a PostgreSQL function that returns the currently authenticated user's ID from their JWT token. With these policies, User A can never read or write User B's data, no matter what API calls they make.

#### REST API (PostgREST)

Supabase automatically generates a complete REST API for every table in your database. You do not need to write any server-side code. If you have a `tasks` table, you immediately get endpoints for creating, reading, updating, and deleting tasks. The API respects RLS policies, so it is secure by default.

### JavaScript Client Library

The `@supabase/supabase-js` library is the official client for interacting with Supabase from JavaScript or TypeScript:

```javascript
import { createClient } from '@supabase/supabase-js';

// Create a client with your project URL and publishable key
const supabase = createClient(
  'https://your-project.supabase.co',
  'your-publishable-key'
);
```

**Querying data:**

```javascript
// Select all tasks for the current user (RLS handles filtering automatically)
const { data, error } = await supabase.from('tasks').select('*');

// Select with filters
const { data } = await supabase
  .from('tasks')
  .select('*')
  .eq('completed', false)       // WHERE completed = false
  .order('created_at', { ascending: false })  // ORDER BY created_at DESC
  .limit(10);                   // LIMIT 10

// Insert a record
const { data, error } = await supabase
  .from('tasks')
  .insert({ name: 'New task', completed: false })
  .select();  // Return the inserted record

// Update a record
const { data, error } = await supabase
  .from('tasks')
  .update({ completed: true })
  .eq('id', 'task-1')
  .select();

// Delete a record
const { error } = await supabase
  .from('tasks')
  .delete()
  .eq('id', 'task-1');
```

**Authentication:**

```javascript
// Sign up a new user
const { data, error } = await supabase.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword'
});

// Sign in an existing user
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'securepassword'
});

// Get the current session (includes the JWT and user info)
const { data: { session } } = await supabase.auth.getSession();
```

**Realtime subscriptions:**

```javascript
// Subscribe to changes on the tasks table
supabase
  .channel('tasks-changes')
  .on('postgres_changes', {
    event: '*',          // INSERT, UPDATE, DELETE, or * for all
    schema: 'public',
    table: 'tasks'
  }, (payload) => {
    console.log('Change received:', payload);
    // payload.new = the new record, payload.old = the previous record
  })
  .subscribe();
```

### How stellar-drive Uses Supabase

- **REST API for push/pull sync operations.** The engine pushes local changes to the server via Supabase's REST API (insert, update, upsert) and pulls remote changes by querying for records updated since the last sync cursor (an `updated_at` timestamp stored in localStorage).
- **Realtime Postgres Changes for instant cross-device updates.** The engine subscribes to PostgreSQL changes on every configured table via Supabase Realtime. When Device A pushes a change, Device B receives it within milliseconds via WebSocket instead of waiting for the next background poll.
- **Realtime Broadcast for CRDT document sync.** Yjs document updates (typically a few bytes per keystroke) are broadcast to other connected clients via Supabase's Broadcast pub/sub channel. This avoids writing every keystroke to the database.
- **Realtime Presence for collaborative cursor tracking.** Supabase Presence tracks which users are currently viewing or editing a document, enabling features like showing collaborator cursors.
- **Auth for single-user PIN mode.** The engine uses Supabase Auth for user registration, login, session management, and token refresh. In single-user mode, the PIN or password is padded to meet Supabase's minimum password length and used as a real Supabase password, giving the user a real `auth.uid()` for RLS compliance.
- **RLS policies enforce per-user data access.** Every table uses `user_id = auth.uid()` policies so users can only access their own data, enforced at the database level. The engine auto-generates these policies via `generateSupabaseSQL()`.
- **SQL generation from schema.** The engine can generate complete Supabase SQL (CREATE TABLE, RLS policies, triggers, indexes, realtime publication) from the same declarative schema passed to `initEngine()`, so the schema in code is the single source of truth for both IndexedDB and PostgreSQL.

---

## 4. Svelte (UI Framework)

### What is Svelte?

Svelte is a UI framework for building web applications. If you have used React or Vue, Svelte fills the same role -- it lets you build interactive user interfaces with components, reactive state, and declarative templates. But Svelte has one fundamental difference: **it is a compiler, not a runtime**.

### The Compiler Difference

In React, when your application runs in the browser, the entire React library is loaded and running. It maintains a "virtual DOM" (an in-memory copy of the page structure), and every time state changes, React diffs the virtual DOM against the real DOM to figure out what to update. This is clever but adds overhead -- both in bundle size (React itself is ~40 KB) and in runtime performance (diffing takes CPU time).

Svelte takes a completely different approach. At build time (when you run `npm run build`), the Svelte compiler reads your component files and generates minimal, highly optimized JavaScript that directly manipulates the DOM. There is no virtual DOM, no diffing, and no framework runtime loaded in the browser. The generated code is typically smaller and faster than the equivalent React code.

Think of it this way:
- **React/Vue**: ships a general-purpose engine to the browser, which interprets your components at runtime
- **Svelte**: compiles your components into specialized code at build time, so only the exact DOM operations needed are shipped to the browser

### Svelte 5 (Current Version, Used by stellar-drive)

Svelte 5 introduced a new reactivity system called **Runes**. Runes are special functions (prefixed with `$`) that tell the Svelte compiler how to handle reactivity.

#### Runes (Reactivity System)

**`$state()`** declares reactive state. When this value changes, anything that depends on it automatically updates:

```svelte
<script>
  let count = $state(0);
  let name = $state('World');
</script>

<button onclick={() => count++}>
  Clicked {count} times
</button>

<p>Hello, {name}!</p>
```

When `count` changes (via the button click), Svelte automatically updates just the text node inside the button. No manual DOM manipulation, no virtual DOM diff -- the compiler generated code that knows exactly which DOM node to update.

**`$derived()`** creates computed values that automatically recalculate when their dependencies change:

```svelte
<script>
  let width = $state(10);
  let height = $state(20);
  let area = $derived(width * height);  // auto-updates when width or height change
</script>

<p>Area: {area}</p>  <!-- Shows 200, updates automatically -->
```

**`$effect()`** runs side effects when dependencies change (similar to React's `useEffect`):

```svelte
<script>
  let searchQuery = $state('');

  $effect(() => {
    // This runs whenever searchQuery changes
    console.log('Searching for:', searchQuery);
    // Could fetch from an API, update localStorage, etc.
  });
</script>
```

The Svelte compiler automatically detects which reactive values are read inside the `$effect` callback and re-runs it when any of them change. Unlike React's `useEffect`, there is no dependency array to maintain -- Svelte figures out the dependencies at compile time.

**`$props()`** declares the properties (inputs) a component accepts from its parent:

```svelte
<script>
  // This component accepts 'name' (required) and 'age' (optional, defaults to 0)
  let { name, age = 0 } = $props();
</script>

<p>{name} is {age} years old</p>
```

**`$bindable()`** creates props that support two-way binding (parent and child can both update the value):

```svelte
<!-- TextInput.svelte -->
<script>
  let { value = $bindable('') } = $props();
</script>

<input bind:value={value} />
```

The parent can then use `bind:value` to create a two-way data flow:

```svelte
<script>
  import TextInput from './TextInput.svelte';
  let name = $state('');
</script>

<TextInput bind:value={name} />
<p>You typed: {name}</p>
```

#### Components

A Svelte component is a `.svelte` file that contains three sections:

```svelte
<script>
  // JavaScript/TypeScript logic
  let count = $state(0);

  function increment() {
    count++;
  }
</script>

<!-- HTML template (with Svelte syntax for reactivity) -->
<button onclick={increment}>
  Count: {count}
</button>

<style>
  /* CSS -- automatically scoped to this component */
  button {
    background: blue;
    color: white;
  }
</style>
```

The `<style>` block is automatically scoped -- the CSS only applies to elements in this component, not to the rest of the page. This eliminates CSS naming conflicts without needing CSS modules or styled-components.

#### Snippets (Template Fragments)

Snippets replaced Svelte 4's "slots" system. They are reusable template fragments that can be passed between components:

```svelte
<script>
  import List from './List.svelte';
</script>

<!-- Define a snippet that describes how to render each item -->
{#snippet itemRenderer(item)}
  <div class="card">
    <h3>{item.name}</h3>
    <p>{item.description}</p>
  </div>
{/snippet}

<!-- Pass the snippet to a generic List component -->
<List items={data} {itemRenderer} />
```

Inside the `List` component, the snippet is rendered with `{@render itemRenderer(item)}`. This is more flexible than the old slot system because snippets are first-class values that can be conditionally passed, stored in variables, or composed.

#### Store Contract

Any JavaScript object with a `subscribe` method is a valid Svelte store. The `subscribe` method must accept a callback and return an unsubscribe function. In Svelte components, you can prefix a store variable with `$` to automatically subscribe and get the current value:

```svelte
<script>
  import { syncStatusStore } from 'stellar-drive';

  // $syncStatusStore automatically subscribes and unsubscribes
  // It always contains the current value of the store
</script>

{#if $syncStatusStore.status === 'syncing'}
  <p>Syncing...</p>
{/if}
```

When the component is created, Svelte calls `syncStatusStore.subscribe(callback)` and updates `$syncStatusStore` whenever the store emits a new value. When the component is destroyed, Svelte calls the unsubscribe function to clean up. This is all automatic -- you never manually manage subscriptions.

### How stellar-drive Integrates with Svelte

- **All stores implement the Svelte store contract** (subscribe method). The engine exports reactive stores: `syncStatusStore` (sync cycle state), `authState` (authentication mode and session), `isOnline` (network connectivity), `isAuthenticated` (derived boolean), and `remoteChangesStore` (tracks which entities were changed by remote sync).
- **Store factory functions** for app-specific data. `createCollectionStore()` and `createDetailStore()` generate Svelte-compatible stores backed by IndexedDB queries. Collection stores load all records for a table; detail stores load a single record by ID. Both refresh automatically after sync cycles.
- **`use:` actions for DOM-level behavior.** Svelte actions are functions that run when an element is mounted. The engine provides `remoteChangeAnimation` (animate elements when remote changes arrive), `trackEditing` (protect user edits from being overwritten by incoming sync), and `truncateTooltip` (attach native tooltips to text-overflow elements).
- **CSS custom properties for theming.** Components use CSS custom properties (variables like `--sync-color`) that consumer apps can override to match their design.
- **Svelte is an OPTIONAL peer dependency.** The core engine (sync, queue, conflicts, realtime, auth, config) is framework-agnostic TypeScript. If a consumer app does not use Svelte, the stores and actions are simply not imported and are tree-shaken away by the bundler.

---

## 5. SvelteKit (Application Framework)

### What is SvelteKit?

SvelteKit is a full-stack application framework built on top of Svelte, in the same way that Next.js is built on top of React. While Svelte handles individual UI components, SvelteKit handles everything else you need to build a complete web application:

- Routing (which component shows for which URL)
- Server-side rendering (generating HTML on the server for fast initial loads)
- API endpoints (server-side code for handling requests)
- Build optimization (code splitting, preloading, asset hashing)
- Deployment (adapters for any hosting platform)

Without SvelteKit, you would need to manually configure a router, a bundler, a dev server, server-side rendering, and deployment. SvelteKit handles all of this with sensible defaults and minimal configuration.

### Key Concepts

#### File-Based Routing

Instead of configuring routes in a JavaScript file, SvelteKit uses the filesystem. The directory structure under `src/routes/` directly maps to URLs:

```
src/routes/
  +page.svelte           --> /           (home page)
  about/
    +page.svelte         --> /about
  blog/
    +page.svelte         --> /blog       (blog listing)
    [slug]/
      +page.svelte       --> /blog/my-post  (dynamic route, slug = "my-post")
  settings/
    profile/
      +page.svelte       --> /settings/profile
```

Each `+page.svelte` file is a page component that renders when the user navigates to that URL. Directories with `[brackets]` create dynamic route parameters extracted from the URL.

#### Load Functions

Load functions are special functions in `+page.ts` or `+layout.ts` files that run **before** the page renders. They fetch data and pass it to the component as props:

```typescript
// src/routes/blog/[slug]/+page.ts
export async function load({ params }) {
  // params.slug comes from the URL (e.g., "my-post")
  const post = await fetchBlogPost(params.slug);
  return { post };  // This becomes available as data.post in the component
}
```

```svelte
<!-- src/routes/blog/[slug]/+page.svelte -->
<script>
  let { data } = $props();
</script>

<h1>{data.post.title}</h1>
<p>{data.post.content}</p>
```

Load functions can run on the server (in `+page.server.ts`) or on the client (in `+page.ts`). Server-only load functions can access databases, secrets, and other server-side resources. Client-side load functions run in the browser and are used for things like reading from IndexedDB or calling browser-only APIs.

#### Layouts

Layouts are shared wrappers that persist across page navigation. A `+layout.svelte` file wraps all pages in its directory (and subdirectories):

```svelte
<!-- src/routes/+layout.svelte (root layout, wraps ALL pages) -->
<script>
  let { children } = $props();
</script>

<nav>
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>

<main>
  {@render children()}  <!-- Page content renders here -->
</main>

<footer>Copyright 2024</footer>
```

When the user navigates between pages, the layout stays mounted (the nav and footer do not re-render), and only the page content changes. This provides instant-feeling navigation.

Layouts can also have their own load functions (`+layout.ts`) that load data shared by all child pages, like user authentication state.

#### Server Routes (API Endpoints)

`+server.ts` files create API endpoints that handle HTTP requests:

```typescript
// src/routes/api/config/+server.ts
import { json } from '@sveltejs/kit';

export async function GET() {
  const config = await loadConfig();
  return json(config);
}

export async function POST({ request }) {
  const body = await request.json();
  await saveConfig(body);
  return json({ success: true });
}
```

This creates `GET /api/config` and `POST /api/config` endpoints that can be called from the frontend or external clients.

#### Route Groups

Directories wrapped in parentheses create "groups" that share a layout without affecting the URL:

```
src/routes/
  (app)/                   <-- Group: shares a layout, but "(app)" is NOT in the URL
    +layout.svelte         <-- Layout with navigation, auth guards
    dashboard/
      +page.svelte         --> /dashboard  (not /app/dashboard)
    settings/
      +page.svelte         --> /settings
  (auth)/                  <-- Different group with a different layout
    +layout.svelte         <-- Layout with centered card, no navigation
    login/
      +page.svelte         --> /login
    signup/
      +page.svelte         --> /signup
```

This lets you have completely different layouts for different sections of your app (e.g., authenticated pages with navigation vs. login pages with a centered form) without adding prefixes to URLs.

#### Hooks

Server hooks (`src/hooks.server.ts`) act like middleware, running on every request before it reaches a route:

```typescript
// src/hooks.server.ts
export async function handle({ event, resolve }) {
  // Run before every request (check auth, log, modify headers, etc.)
  const session = await getSession(event.cookies);
  event.locals.user = session?.user;
  return resolve(event);
}
```

#### Adapters

SvelteKit adapters configure how your app is deployed. Different adapters target different platforms:

- `adapter-vercel` -- deploy to Vercel
- `adapter-netlify` -- deploy to Netlify
- `adapter-node` -- deploy as a Node.js server
- `adapter-static` -- generate a fully static site (no server needed)

You configure the adapter in `svelte.config.js` and SvelteKit handles the rest.

### How stellar-drive Integrates with SvelteKit

SvelteKit integration is provided through the `stellar-drive/kit` subpath export. It is entirely optional -- the core engine works without SvelteKit.

- **Layout load function factories.** `resolveRootLayout()` is a factory that generates the root `+layout.ts` load function. It initializes the engine, loads runtime configuration (Supabase URL and keys) from the server, determines the current auth state (Supabase session, offline session, demo mode, or unauthenticated), and starts the background sync engine. `resolveProtectedLayout()` guards route groups that require authentication, redirecting unauthenticated users to the login page.
- **Server API handlers.** `getServerConfig()` creates a `GET` handler for `/api/config` that serves the Supabase URL and publishable key from server-side environment variables. `createValidateHandler()` creates a `POST` handler for validating Supabase connection credentials during initial setup.
- **Auth hydration.** `hydrateAuthState()` bridges SvelteKit load data (available on first render) to reactive stores (used throughout the app lifecycle), ensuring the `authState` store is populated before any component reads it.
- **Email confirmation.** `handleEmailConfirmation()` processes the token exchange when a user clicks an email confirmation link, converting the URL token into a Supabase session.
- **Service worker lifecycle.** `pollForNewServiceWorker()` and `monitorSwLifecycle()` manage PWA service worker updates, prompting users when a new version is available.
- **Project scaffolding.** The CLI command `stellar-drive install pwa` generates a complete SvelteKit project structure with routes, layouts, service worker, manifest, and configuration files.

---

## 6. Yjs (CRDT Library)

### What is Yjs?

Yjs is a high-performance implementation of CRDTs (Conflict-free Replicated Data Types) in JavaScript. It enables real-time collaborative editing -- the kind of experience you see in Google Docs, where multiple users can edit the same document simultaneously and all changes merge together automatically.

### What are CRDTs?

CRDT stands for **Conflict-free Replicated Data Type**. To understand why they matter, consider the problem they solve.

Imagine two users, Alice and Bob, are editing the same text document that currently says "The cat". Alice adds " sat" at the end (making "The cat sat"), and at the same time (before either sees the other's change), Bob adds "big " before "cat" (making "The big cat"). With a naive approach, you have a conflict -- whose version wins? Do you overwrite one person's work? Show a conflict dialog?

CRDTs are data structures mathematically designed so that **any two copies can always be merged automatically, without conflicts, regardless of the order operations arrive**. Both edits survive: the final document becomes "The big cat sat" on every device, even if the operations arrive in different orders.

The key insight is that each operation in a CRDT carries enough metadata (who made it, when, and where in the document) to be placed unambiguously, no matter what other operations have been applied. This is achieved through a structure where each character (or element) has a globally unique ID and a reference to its left neighbor at the time of insertion.

### Why CRDTs Matter

Without CRDTs, collaborative editing requires a central server that serializes all operations (like Operational Transformation, used by the original Google Docs). That approach:
- Requires a persistent server connection
- Does not work offline
- Has complex edge cases around operation ordering that are hard to get right

CRDTs eliminate these problems. Each client has a complete local copy, can edit freely offline, and merges are always automatic and correct. This aligns perfectly with an offline-first architecture.

### How CRDTs Differ from the Engine's Regular Sync

The engine's regular sync system (push/pull with conflict resolution) handles structured records -- rows in a table with fields like `title`, `completed`, `order`. When two devices change the same field on the same record, the engine uses last-write-wins or additive merge to resolve the conflict. This works well for discrete values but breaks down for text -- you cannot meaningfully "last-write-wins" two people typing in the same paragraph.

CRDTs solve the text problem by tracking every individual character insertion and deletion as a separate, ordered operation. This is why the engine uses both systems: structured records go through the push/pull sync queue, and rich text content goes through Yjs.

### Key Shared Types in Yjs

Yjs provides several collaborative data types that mirror common JavaScript data structures:

**`Y.Text`** is collaborative text. Multiple users can type, delete, and format text simultaneously. It supports rich-text attributes (bold, italic, etc.) and is commonly used with text editors like Tiptap, ProseMirror, or CodeMirror:

```javascript
const ytext = ydoc.getText('document-title');
ytext.insert(0, 'Hello ');       // Insert "Hello " at position 0
ytext.insert(6, 'World');        // Insert "World" at position 6
ytext.toString();                // "Hello World"

// Rich text formatting
ytext.format(0, 5, { bold: true });  // Make "Hello" bold
```

**`Y.Array`** is a collaborative ordered list. Items can be inserted, deleted, and moved by multiple users:

```javascript
const yarray = ydoc.getArray('todo-list');
yarray.insert(0, ['Buy groceries']);
yarray.insert(1, ['Walk the dog']);
yarray.push(['Read a book']);
yarray.toArray();  // ['Buy groceries', 'Walk the dog', 'Read a book']
```

**`Y.Map`** is a collaborative key-value store, like a JavaScript object that multiple users can edit:

```javascript
const ymap = ydoc.getMap('settings');
ymap.set('theme', 'dark');
ymap.set('fontSize', 14);
ymap.get('theme');  // 'dark'
```

**`Y.XmlFragment`** is a collaborative XML tree structure. It is primarily used by block editors like Tiptap (which represents documents as XML-like trees of nodes):

```javascript
const yfragment = ydoc.getXmlFragment('editor-content');
// Typically manipulated by editor bindings, not directly
```

### How Sync Works in Yjs

Each Yjs document (`Y.Doc`) tracks all changes as operations. Every operation is uniquely identified by a `(clientId, clock)` tuple:

- **clientId**: a random number assigned to each peer (browser tab, device)
- **clock**: a counter that increments with each operation on that client

This means every character typed, every deletion, every formatting change has a globally unique identifier.

**State vectors** track what each peer has seen. A state vector is a map of `{ clientId: lastSeenClock }`. When two peers connect, they exchange state vectors, and each peer can compute exactly which operations the other is missing.

**Delta sync** means only missing operations are sent. If Alice has made 1000 edits and Bob has seen 990 of them, only the 10 missing edits are transmitted. This makes sync extremely efficient, even for large documents.

**Merging** is automatic and deterministic. Given the same set of operations (in any order), every peer produces the exact same final document. There are no conflicts, no merge dialogs, no "your version vs. their version."

### How stellar-drive Uses Yjs

The engine's CRDT subsystem is optional (enabled by passing `crdt: true` or `crdt: {}` to `initEngine()`) and used for rich collaborative content like text documents or structured editors:

```typescript
initEngine({
  prefix: 'myapp',
  schema: {
    tasks: 'project_id, order',
    settings: { singleton: true },
  },
  auth: { gateType: 'code', codeLength: 6 },
  crdt: true,
});
```

- **Documents are `Y.Doc` instances managed by `CRDTProvider`.** Each collaborative document is opened via `openDocument(documentId, pageId)`, which returns a provider containing the `Y.Doc`. The provider manages the full lifecycle: loading state, wiring up persistence, and broadcasting updates.
- **Updates broadcast via Supabase Realtime Broadcast** (not database writes per keystroke). When a user types a character, the Yjs update (typically a few bytes) is broadcast to other connected clients via Supabase's pub/sub channel. This is far more efficient than writing every keystroke to the database.
- **Two IndexedDB tables for local persistence.** `crdtDocuments` stores the full Yjs document state (for offline access and cross-session recovery). `crdtPendingUpdates` stores incremental update deltas for crash safety -- if the browser crashes between full saves, these deltas are replayed on next load.
- **Periodic full-state persistence to Supabase.** The complete document state is saved to the `crdt_documents` Supabase table at regular intervals. This serves as a durable backup and allows new devices to load the latest state without replaying all historical operations.
- **Consumers never need to import Yjs directly.** All Yjs types and utilities needed by consumer applications are re-exported from the `stellar-drive/crdt` subpath export, keeping the dependency tree clean.
