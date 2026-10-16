
require("dotenv").config();

const { Pool } = require("pg");

const testSchema = process.env.NUTIKALS_TEST_SCHEMA || "";
if (testSchema && (process.env.NODE_ENV !== "test" || !/^nutikals_test_[a-f0-9]{12}$/.test(testSchema))) {
    throw new Error("NUTIKALS_TEST_SCHEMA is only allowed for a validated test schema in NODE_ENV=test.");
}

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: testSchema ? `-c search_path=${testSchema},public` : undefined
});

module.exports = pool;
