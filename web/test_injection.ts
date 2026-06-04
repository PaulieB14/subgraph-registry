// Test if LIKE and BETWEEN can actually execute subqueries in DuckDB
// The finding claims:
// 1. LIKE CAST((SELECT ...)) can extract data
// 2. BETWEEN ... AND (SELECT ...) can execute subqueries

// Example 1: LIKE with CAST and subquery
const example1 = `SELECT * FROM settlements WHERE recipient LIKE CAST((SELECT column_name FROM information_schema.columns LIMIT 1) AS VARCHAR)`;

// Example 2: BETWEEN with subquery
const example2 = `SELECT * FROM settlements WHERE amount BETWEEN 0 AND (SELECT COUNT(*) FROM settlements)`;

console.log("Example 1 (LIKE with CAST subquery):");
console.log(example1);
console.log("\nExample 2 (BETWEEN with subquery):");
console.log(example2);
