SELECT name
FROM pragma_table_info('sessions')
WHERE name = ?;
