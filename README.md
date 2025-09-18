# Advanced-Salesforce-List-View
Tired of the limitations in standard list views? Advanced Salesforce List View is an open-source Lightning Web Component that brings powerful filtering (including Date/DateTime), smooth server-side pagination, flexible sorting, and a polished, responsive UI. Drop it on any Record, Home, or App page and configure it in minutes.

### Current Features
- Server-side pagination with total count and range display
- Client-side debounced searching across selected fields
- Selective sorting on a per-field whitelist
- Dynamic filter panel
	- Picklist and Multi-Picklist filters (record type aware)
	- Date filters: On or Between
	- DateTime filters: On (calendar day/local) or Between
	- Apply, Cancel, and Clear All with validation
- Uniform, accessible pagination controls and page-size selector
- Evenly distributed columns with wrapping and alignment by data type
- Error handling with sticky toasts and clear empty/loading states
- Optional row numbers
- Refresh button and public API to refresh/clear search
- Works on lightning__RecordPage, lightning__HomePage, and lightning__AppPage

### Features to be added in future releases:
- Inline actions menu (View/Edit/Delete) with standard navigation
- Column renderers for references (record links) and richer types
- CSV export that respects current filters and sort
- Saved filter presets per user
- Virtualized rows for very large pages
- Column-level configuration via metadata for admins (no code)
- Inline editing where supported by lightning-datatable
- Better currency/locale controls
- Enforce user access control

## Basic view of how the List View looks
<img width="2416" height="1140" alt="Screenshot 2025-09-18 at 09-10-49 2025 Aston Martin DB12 Goldfinger Model Salesforce" src="https://github.com/user-attachments/assets/a33885b3-48fb-441d-983c-28c1628c5083" />

## The filters panel
<img width="2414" height="1141" alt="Screenshot 2025-09-18 at 09-10-57 2025 Aston Martin DB12 Goldfinger Model Salesforce" src="https://github.com/user-attachments/assets/44680dd8-6f4b-4aa5-91c4-b4247ea99668" />

## Configuration options inside the Lightning Page Editor
<img width="594" height="1743" alt="Screenshot 2025-09-18 at 09-11-17 Model Record Page - Lightning App Builder" src="https://github.com/user-attachments/assets/9d5f4f92-3b2e-4521-99c2-85703978ea24" />

## Contributing:
We welcome issues and PRs! Please:
- Describe bugs with repro steps and org context
- Keep PRs focused; include before/after notes or screenshots
- Follow SLDS and LWC best practices and include tests where possible

### License:
MIT. See LICENSE for details.
