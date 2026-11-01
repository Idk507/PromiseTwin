---
paths:
  - "app/src/backend/**"
  - "app/src/domain/**"
---
Validate external arguments at boundary; authorization on server; no free-form SQL/query assembled from client inputs; no implied trust in source content. All domain state transitions need a positive and a negative unit test, and docstrings for public functions.
