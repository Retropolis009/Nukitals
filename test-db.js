
const pool = require("./db");

async function testConnection() {
    try {
        const result = await pool.query(`
            SELECT
                current_database() AS database,
                current_user AS username,
                COUNT(*) AS product_count
            FROM products
        `);

        console.log("Database connection successful!");
        console.log(result.rows[0]);
    } catch (error) {
        console.error("Database connection failed:", error.message);
    } finally {
        await pool.end();
    }
}

testConnection();
