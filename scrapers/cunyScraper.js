// scrapers/cunyScraper.js (Final Integrated Version)
const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const ScrapedEvent = require('../models/ScrapedEvent');

async function scrapeAndSaveCunyEvents(mongoUri) {
    if (!mongoUri) {
        throw new Error('MongoDB URI is required to save scraped events.');
    }

    // Database connection
    console.log('🔌 Connecting to MongoDB...');
    try {
        await mongoose.connect(mongoUri, {
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000
        });
        console.log('✅ MongoDB connected for scraping.');
    } catch (dbError) {
        console.error('❌ MongoDB connection failed:', dbError);
        return { success: false, error: 'Database connection failed' };
    }

    // Browser setup
    console.log('🚀 Launching headless browser...');
    const browser = await puppeteer.launch({
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    );
    page.setDefaultTimeout(60000);

    // Initial page load
    const targetUrl = 'https://events.cuny.edu/';
    console.log(`📡 Navigating to ${targetUrl}...`);
    
    try {
        await page.goto(targetUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await page.waitForSelector('li.cec-list-item', { timeout: 30000 });
    } catch (error) {
        console.error('❌ Failed to load initial page:', error);
        await browser.close();
        await mongoose.disconnect();
        return { success: false, error: 'Failed to load page' };
    }

    // Scraping logic
    let allEvents = [];
    let hasNextPage = true;
    let currentPage = 1;
    let retryCount = 0;
    const maxRetries = 3;
    const maxPagesToScrape = 5; // Limit to be nice to their server

    while (hasNextPage && currentPage <= maxPagesToScrape && retryCount < maxRetries) {
        console.log(`🔍 Scraping page ${currentPage}...`);
        
        try {
            await page.waitForSelector('li.cec-list-item', { timeout: 30000 });

            const pageEvents = await page.evaluate(() => {
                const eventNodes = document.querySelectorAll('li.cec-list-item');
                const eventData = [];

                eventNodes.forEach(node => {
                    const titleElement = node.querySelector('h2.low a');
                    const collegeElement = node.querySelector('h4.low-normal:nth-of-type(1)');
                    const dateElement = node.querySelector('h4.low-normal:nth-of-type(2)');
                    const timeElement = node.querySelector('h4:not(.low-normal)');
                    const link = titleElement?.href;

                    if (titleElement && dateElement && link) {
                        eventData.push({
                            title: titleElement.innerText.trim(),
                            college: collegeElement?.innerText.trim() || 'Not specified',
                            date: dateElement.innerText.trim(),
                            time: timeElement?.innerText.trim() || 'Not specified',
                            sourceUrl: link,
                            scrapedAt: new Date() // Add timestamp
                        });
                    }
                });

                return eventData;
            });

            allEvents = [...allEvents, ...pageEvents];
            console.log(`✅ Found ${pageEvents.length} events on page ${currentPage}. Total so far: ${allEvents.length}`);
            retryCount = 0;

            // Pagination handling
            const nextButton = await page.$('.pagination a[href*="page"]:not([href*="page/1"]):not(.disabled)');
            if (nextButton) {
                currentPage++;
                console.log(`➡️ Navigating to page ${currentPage}...`);
                
                try {
                    await Promise.all([
                        nextButton.click(),
                        page.waitForNavigation({ 
                            waitUntil: 'domcontentloaded',
                            timeout: 60000 
                        })
                    ]);
                    // Alternative to waitForTimeout for older Puppeteer versions
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (error) {
                    console.error(`⚠️ Failed to navigate to page ${currentPage}:`, error.message);
                    retryCount++;
                    if (retryCount < maxRetries) {
                        console.log(`🔄 Retrying page ${currentPage} (attempt ${retryCount + 1}/${maxRetries})`);
                        continue;
                    } else {
                        hasNextPage = false;
                    }
                }
            } else {
                hasNextPage = false;
            }
        } catch (error) {
            console.error(`⚠️ Error scraping page ${currentPage}:`, error.message);
            retryCount++;
            if (retryCount < maxRetries) {
                console.log(`🔄 Retrying page ${currentPage} (attempt ${retryCount + 1}/${maxRetries})`);
                continue;
            } else {
                hasNextPage = false;
            }
        }
    }

    // Database operations
    let newEventsCount = 0;
    let duplicateEventsCount = 0;
    let errorCount = 0;

    if (allEvents.length > 0) {
        console.log('💾 Saving events to database...');
        
        for (const event of allEvents) {
            try {
                const result = await ScrapedEvent.updateOne(
                    { sourceUrl: event.sourceUrl },
                    { $set: event },
                    { upsert: true }
                );
                
                if (result.upsertedCount > 0) {
                    newEventsCount++;
                } else if (result.modifiedCount > 0) {
                    duplicateEventsCount++;
                }
            } catch (error) {
                errorCount++;
                if (error.code !== 11000) { // Skip duplicate key errors
                    console.error('Error saving event:', error);
                }
            }
        }
    }

    console.log(`✅ Database update complete. 
    New events: ${newEventsCount}
    Updated events: ${duplicateEventsCount}
    Errors: ${errorCount}`);

    // Cleanup
    await browser.close();
    await mongoose.disconnect();
    console.log('🏁 Scraper finished and disconnected from DB.');
    
    return { 
        success: true, 
        stats: {
            totalFound: allEvents.length,
            newEvents: newEventsCount,
            updatedEvents: duplicateEventsCount,
            errors: errorCount
        }
    };
}

module.exports = { scrapeAndSaveCunyEvents };