-- Validate separately so the expansion does not scan under ACCESS EXCLUSIVE.
ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
