
const pool = require("./db");

async function testConnection() {
    try {
        const result = await pool.query(`
            SELECT (SELECT COUNT(*) FROM products) AS product_count
        `);

        console.log(`Database connection successful. Products: ${result.rows[0].product_count}`);
    } catch (error) {
        console.error("Database connection failed:", error.message);
    } finally {
        await pool.end();
    }
}

testConnection();
