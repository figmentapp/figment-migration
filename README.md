# Figment Migration

Micro-service that migrates Figment projects from an older version to a newer version. 

## WebGL → WebGPU nodes

In March 2026, we migrated from WebGL to WebGPU. This means all custom nodes need to be updated to use WebGPU instead. Users can drag and drop their .fgmt files in the migration tool; or they can upload the source code for a node. In both cases, the tool will convert the code to WebGPU.
