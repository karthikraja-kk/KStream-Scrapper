# KStream Scraper Specification

This document details the step-by-step logic for the KStream scraper and how the extracted data maps to the Supabase database.

---

## 1. Data Mapping

### Table: `movies`
| Field | Extraction Source | Step | Note |
| :--- | :--- | :--- | :--- |
| `movie_url` | Final URL of the movie page | 2/3 | Unique Identifier |
| `movie_name` | H1 tag or Title minus year/meta | 5 | Cleaned title |
| `year` | Extracted from Title `(YYYY)` | 5 | Integer |
| `duration` | "Duration:" or "Run Time:" key | 11 | Extracted from Download Page |
| `synopsis` | `.movie-synopsis` text content | 5 | Cleaned of "Synopsis:" prefix |
| `director` | "Director:" span value | 5 | Array |
| `cast_members` | "Starring:" span value | 5 | Array (Split by `,`, `|`, `&`) |
| `genres` | "Genres:" span value | 5 | Array |
| `type` | "Quality:" span value | 5 | e.g., "Original HD" |
| `language` | "Language:" span value | 5 | e.g., "Tamil" |
| `rating` | "Movie Rating:" span value | 5 | Cleaned (removed `/10`) |
| `poster_url` | `<picture>` source or img src | 5 | Full URL (prepend base if relative) |

### Table: `media`
| Field | Extraction Source | Step | Note |
| :--- | :--- | :--- | :--- |
| `movie_id` | Foreign Key from `movies.id` | - | Linked after movie insertion |
| `quality` | Label inside `()` from folder name | 8 | e.g., "1080p HD", "720p HD" |
| `file_size` | "File Size:" key content | 10 | Winner of the "Largest File" check |
| `download_url_1` | Final Direct File URL from Srv 1 | TBD | **To Be Decided (Step 12+)** |
| `download_url_2` | Final Direct File URL from Srv 2 | TBD | **To Be Decided (Step 12+)** |
| `watch_url_1` | Final Stream URL from Srv 1 | TBD | **To Be Decided (Step 12+)** |
| `watch_url_2` | Final Stream URL from Srv 2 | TBD | **To Be Decided (Step 12+)** |

---

## 2. Scraping Workflow (Step-by-Step)

### Phase 1: Discovery (Index Crawler)
*   **Step 1: Discover Year Folders**
    *   Target: Home Page.
    *   Logic: Find `div.f` containing `img[src*="folder.svg"]`.
    *   Filter: Name must contain a 4-digit year.
*   **Step 2: Access Year Folder**
    *   Target: Year URL (e.g., `/tamil-2026-movies/`).
    *   Logic: Identify all movie links in `div.f` with `folder.svg`.
*   **Step 3: Pagination & De-duplication**
    *   Selector: `div.pagecontent a`.
    *   Logic: Look for "Next" or `»`. Recursively fetch all pages.
    *   De-duplication: Use a global `Set` to store URLs and ensure no duplicates across pages.

### Phase 2: Metadata (Detail Scraper)
*   **Step 4: Extract Movie Metadata**
    *   Target: Movie URL (e.g., `/youth-2026-tamil-movie/`).
    *   Logic: Map HTML elements to the `movies` table fields (Poster, Director, etc.).
*   **Step 5: Navigate to Quality Selection**
    *   Logic: Find the primary folder link (usually labelled "(Original)") on the movie page.
*   **Step 6: List Available Qualities**
    *   Target: Quality Selection URL (e.g., `/youth-original-movie/`).
    *   Logic: Find all folder links (`folder.svg`).
*   **Step 7: Parse Quality Labels**
    *   Logic: Extract text between `(` and `)` (e.g., "720p HD"). This becomes the `quality` field.

### Phase 3: Media & Files (Media Scraper)
*   **Step 8: Identify Download Pages**
    *   Target: Quality Page (e.g., `/youth-720p-hd-movie/`).
    *   Logic: Find all links matching `/download/`.
*   **Step 9: Selection of Largest File**
    *   Logic: Inspect the `File Size:` key for every link on the page.
    *   Winner: Select the link with the highest MB/GB value.
*   **Step 10: Access Download Details**
    *   Target: Winner URL (e.g., `/download/youth-2026-original-720p-hd/`).
*   **Step 11: Final Metadata & Server Entry**
    *   Logic: Extract **Duration** (updates both tables).
    *   Logic: Capture initial redirect URLs for **Server 1** and **Server 2**.

### Phase 4: Final URLs
*   **Step 12: Follow Server Chains**
    *   Target: Initial Server 1 & 2 URLs.
    *   Logic: (Repeat for both Server 1 and Server 2)
        1.  Visit Initial Server Page.
        2.  Click "Download Server X".
        3.  Visit Redirect Page.
        4.  Click "Download Server X" again.
        5.  Visit Final Page.
        6.  Click "Download Server X" for the final direct .mp4 URL.
        7.  Click "Watch Online Server X" for the final streaming URL.
