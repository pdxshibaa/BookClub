import React, { useState, useEffect } from 'react';
import { db, auth } from './firebase';
import { collection, onSnapshot, addDoc, updateDoc, deleteDoc, doc, query, orderBy } from 'firebase/firestore';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import './App.css';

// TODO: Add the email addresses of admins who are allowed to add Read/Scheduled books
const ADMIN_EMAILS = ["sharon@tutorshiba.com"];
const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1uVwfBjOxbpjiKBwH7-Rfakkgr3lu-krG3EcdzrMEmW4/export?format=csv";
const NYT_API_KEY = import.meta.env.VITE_NYT_API_KEY;
const GOOGLE_BOOKS_API_KEY = import.meta.env.VITE_GOOGLE_BOOKS_API_KEY;

// Helper to parse date safely for Safari/iOS
const parseDate = (dateStr) => {
  if (!dateStr) return new Date(0);
  
  // Try standard parse first
  let date = new Date(dateStr);
  if (!isNaN(date.getTime())) return date;

  // Handle "Month Year" format manually (e.g., "September 2025")
  const parts = dateStr.trim().split(/[\s-]+/);
  if (parts.length >= 2) {
    const monthName = parts[0].toLowerCase().substring(0, 3);
    const year = parseInt(parts[parts.length - 1]);
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };
    
    if (months[monthName] !== undefined && !isNaN(year)) {
      return new Date(year, months[monthName], 1);
    }
  }
  
  return new Date(0);
};

const App = () => {
  // State for books and UI
  const [user, setUser] = useState(null); // Logged in user
  const [showLogin, setShowLogin] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [activeTab, setActiveTab] = useState('read'); // 'read', 'suggested', 'search'
  const [searchQuery, setSearchQuery] = useState('');
  const [filterQuery, setFilterQuery] = useState(''); // Search within lists
  const [searchResults, setSearchResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  
  // State for books (synced with Firebase)
  const [myBooks, setMyBooks] = useState([]);

  // Helper to check if user is admin
  const isAdmin = (currentUser) => {
    return currentUser && ADMIN_EMAILS.some(email => email.toLowerCase() === currentUser.email.toLowerCase());
  };

  // 1. Listen for Authentication State Changes
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  // 2. Listen for Real-time Data from Firestore
  useEffect(() => {
    const q = query(collection(db, "books"), orderBy("sortDate", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const booksData = snapshot.docs.map(doc => ({
        ...doc.data(),
        key: doc.id // Use Firestore ID as key
      }));
      setMyBooks(booksData);
    });
    return () => unsubscribe();
  }, []);

  // Handle Login
  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, email, password);
      setShowLogin(false);
      setEmail('');
      setPassword('');
    } catch (error) {
      alert("Login failed: " + error.message);
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  // Reusable search function
  const executeSearch = async (queryText) => {
    if (!queryText || !queryText.trim()) return;
    
    setIsLoading(true);
    setActiveTab('search');
    setSearchResults([]);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // Increase to 15 seconds

    const apiKeyParam = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : '';
    try {
      const response = await fetch(
        `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(queryText)}&maxResults=40&printType=books${apiKeyParam}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 429) {
          throw new Error("Please wait a moment and try again.");
        }
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Map Google Books result to our app's format
      const formattedBooks = (data.items || []).map(item => {
        const title = item.volumeInfo.title;
        const authors = item.volumeInfo.authors || ['Unknown'];
        const authorString = authors.join(' ');

        // Extract ISBN
        let isbn = null;
        if (item.volumeInfo.industryIdentifiers) {
           const identifier = item.volumeInfo.industryIdentifiers.find(id => id.type === 'ISBN_13') || 
                              item.volumeInfo.industryIdentifiers.find(id => id.type === 'ISBN_10');
           if (identifier) isbn = identifier.identifier;
        }

        return {
          key: item.id,
          title: title,
          author_name: authors,
          coverUrl: item.volumeInfo.imageLinks?.thumbnail?.replace('http:', 'https:'),
          isbn: isbn,
          goodreadsLink: `https://www.goodreads.com/search?q=${encodeURIComponent(title + ' ' + authorString)}`,
          wcclsLink: `https://wccls.bibliocommons.com/v2/search?query=${encodeURIComponent(title + ' ' + authorString)}&searchType=smart`,
          multcolibLink: `https://multcolib.bibliocommons.com/v2/search?query=${encodeURIComponent(title + ' ' + authorString)}&searchType=smart`
        };
      });

      setSearchResults(formattedBooks);
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error("Search timed out:", error);
        alert("The book search timed out. Please try again.");
      } else {
        console.error("Error fetching books:", error);
        alert(`Failed to search books: ${error.message}`);
      }
      setSearchResults([]); // Clear previous results on error
    } finally {
      clearTimeout(timeoutId);
      setIsLoading(false);
    }
  };

  // Search Google Books API (Form Submit)
  const handleSearch = async (e) => {
    e.preventDefault();
    executeSearch(searchQuery);
  };

  // Quick Search Handler
  const handleQuickSearch = (term) => {
    setSearchQuery(term); // Update UI input
    executeSearch(term);
  };

  // Fetch NYT Bestseller List
  const fetchNYTList = async (listName) => {
    if (!NYT_API_KEY || NYT_API_KEY === "YOUR_NYT_API_KEY_HERE") {
      alert("To view real NYT Bestsellers, you need an API Key.\n1. Go to developer.nytimes.com\n2. Create an account & App\n3. Copy the 'API Key' (not App ID) and paste it into src/App.jsx");
      return;
    }

    setIsLoading(true);
    setActiveTab('search');

    try {
      const response = await fetch(`https://api.nytimes.com/svc/books/v3/lists/current/${listName}.json?api-key=${NYT_API_KEY.trim()}`);
      if (!response.ok) {
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      const formattedBooks = (data.results?.books || []).map(item => ({
        key: item.primary_isbn13 || item.primary_isbn10 || item.title,
        title: item.title,
        author_name: [item.author],
        coverUrl: item.book_image || `https://covers.openlibrary.org/b/isbn/${item.primary_isbn13}-M.jpg`,
        isbn: item.primary_isbn13,
        goodreadsLink: `https://www.goodreads.com/search?q=${encodeURIComponent(item.title + ' ' + item.author)}`,
        wcclsLink: `https://wccls.bibliocommons.com/v2/search?query=${encodeURIComponent(item.title + ' ' + item.author)}&searchType=smart`,
        multcolibLink: `https://multcolib.bibliocommons.com/v2/search?query=${encodeURIComponent(item.title + ' ' + item.author)}&searchType=smart`
      }));

      setSearchResults(formattedBooks);
    } catch (error) {
      console.error("Error fetching NYT list:", error);
      alert(`Failed to fetch NYT Bestsellers: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // Action: Add book to Firestore
  const addBookToFirebase = async (book, status = 'suggested') => {
    if (!user) {
      alert("Please log in to add books!");
      setShowLogin(true);
      return;
    }

    if (status !== 'suggested' && !isAdmin(user)) {
      alert("Only admins can add to the Read or Scheduled lists.");
      return;
    }

    if (window.confirm(`Add "${book.title}" to the ${status} list?`)) {
      let displayDate = status === 'read' ? new Date().toLocaleDateString() : '';
      let sortDate = new Date().toISOString();
      let proposer = user.email.split('@')[0];
      let comments = '';

      // Always prompt for details
      const inputDate = window.prompt("Enter Month/Year (e.g. 'January 2025'):", displayDate);
      if (inputDate !== null) {
        displayDate = inputDate;
        const parsed = parseDate(displayDate);
        if (parsed.getTime() !== new Date(0).getTime()) {
          sortDate = parsed.toISOString();
        }
      }

      const inputProposer = window.prompt("Enter Proposer Name:", proposer);
      if (inputProposer !== null) proposer = inputProposer;

      const inputComments = window.prompt("Enter Comments:", "");
      if (inputComments !== null) comments = inputComments;

      try {
        await addDoc(collection(db, "books"), {
          title: book.title,
          author_name: book.author_name,
          coverUrl: book.coverUrl || null,
          isbn: book.isbn || null,
          status: status,
          sortDate: sortDate,
          displayDate: displayDate,
          proposer: proposer,
          comments: comments,
          goodreadsLink: `https://www.goodreads.com/search?q=${encodeURIComponent(book.title + ' ' + (Array.isArray(book.author_name) ? book.author_name.join(' ') : book.author_name))}`,
          wcclsLink: `https://wccls.bibliocommons.com/v2/search?query=${encodeURIComponent(book.title + ' ' + (Array.isArray(book.author_name) ? book.author_name.join(' ') : book.author_name))}&searchType=smart`,
          multcolibLink: `https://multcolib.bibliocommons.com/v2/search?query=${encodeURIComponent(book.title + ' ' + (Array.isArray(book.author_name) ? book.author_name.join(' ') : book.author_name))}&searchType=smart`,
          attemptedV2: !!book.coverUrl // If we already have a cover, don't fetch again
        });
        alert("Book added!");
        setActiveTab(status);
        setSearchQuery('');
      } catch (e) {
        console.error("Error adding book: ", e);
        alert("Error adding book.");
      }
    }
  };

  // Action: Edit book details (Admin only)
  const editBook = async (book) => {
    if (!user || !isAdmin(user)) return;

    const newDisplayDate = window.prompt("Edit Date (Month/Year):", book.displayDate || "");
    if (newDisplayDate === null) return;

    const newProposer = window.prompt("Edit Proposer:", book.proposer || "");
    if (newProposer === null) return;

    const newComments = window.prompt("Edit Comments:", book.comments || "");
    if (newComments === null) return;

    let newSortDate = book.sortDate;
    if (newDisplayDate !== book.displayDate) {
      const parsed = parseDate(newDisplayDate);
      if (parsed.getTime() !== new Date(0).getTime()) {
        newSortDate = parsed.toISOString();
      }
    }

    try {
      const bookRef = doc(db, "books", book.key);
      await updateDoc(bookRef, {
        displayDate: newDisplayDate,
        proposer: newProposer,
        comments: newComments,
        sortDate: newSortDate
      });
    } catch (e) {
      console.error("Error updating book: ", e);
      alert("Error updating book.");
    }
  };

  // Action: Delete book
  const removeBook = async (bookKey) => {
    if (!user || !isAdmin(user)) return;
    if (window.confirm("Are you sure you want to delete this book?")) {
      await deleteDoc(doc(db, "books", bookKey));
    }
  };

  // Action: Migrate data from Google Sheet to Firebase (Admin only)
  const migrateFromGoogleSheet = async () => {
    if (!user || !isAdmin(user)) return;
    if (!window.confirm("Import new books from Google Sheet?")) return;

    setIsLoading(true);
    try {
      const res = await fetch(GOOGLE_SHEET_CSV_URL);
      const text = await res.text();
      const allRows = text.split('\n');
      if (allRows.length < 2) throw new Error("No data found");

      const headers = allRows[0].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
      
      // Identify columns
      const titleIdx = headers.findIndex(h => h.includes('title') || h.includes('book'));
      const authorIdx = headers.findIndex(h => h.includes('author'));
      const dateIdx = headers.findIndex(h => h.includes('month') || h.includes('read') || h.includes('year'));
      const proposerIdx = headers.findIndex(h => h.includes('proposer') || h.includes('host'));
      const isbnIdx = headers.findIndex(h => h.includes('isbn'));
      const commentsIdx = headers.findIndex(h => h.includes('comment') || h.includes('note'));

      // Fallback indices if headers aren't found (assuming standard order: Title, Author, ISBN, Proposer, Month, Comments)
      const tI = titleIdx !== -1 ? titleIdx : 0;
      const aI = authorIdx !== -1 ? authorIdx : 1;

      let count = 0;
      const batchPromises = [];
      
      // Create a Set of existing titles to check for duplicates (case-insensitive)
      const existingTitles = new Set(myBooks.map(b => b.title.toLowerCase().trim()));

      for (let i = 1; i < allRows.length; i++) {
        const row = allRows[i];
        const cols = row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
        if (cols.length <= Math.max(tI, aI)) continue;

        const title = cols[tI];
        const author = cols[aI];
        if (!title) continue;

        // Check if title already exists
        const normalizedTitle = title.toLowerCase().trim();
        if (existingTitles.has(normalizedTitle)) {
          continue;
        }
        // Add to set to prevent duplicates within the same import batch
        existingTitles.add(normalizedTitle);

        const monthYear = dateIdx !== -1 ? (cols[dateIdx] || '') : '';
        const proposer = proposerIdx !== -1 ? (cols[proposerIdx] || '') : '';
        const isbn = isbnIdx !== -1 ? cols[isbnIdx] : null;
        const comments = commentsIdx !== -1 ? cols[commentsIdx] : '';
        
        let dateObj = parseDate(monthYear);
        let status = 'read';
        // Check if a specific month is mentioned (Jan, Feb, etc.)
        const hasMonth = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(monthYear);
        
        if (!hasMonth) {
          status = 'suggested';
        } else if (dateObj > new Date()) {
          status = 'scheduled';
        }
        // Add slight time offset to preserve order
        dateObj.setTime(dateObj.getTime() + i * 1000);

        const bookData = {
          title: title,
          author_name: [author],
          isbn: isbn,
          coverUrl: null,
          status: status,
          sortDate: dateObj.toISOString(),
          displayDate: monthYear,
          proposer: proposer,
          comments: comments,
          goodreadsLink: `https://www.goodreads.com/search?q=${encodeURIComponent(title + ' ' + author)}`,
          wcclsLink: `https://wccls.bibliocommons.com/v2/search?query=${encodeURIComponent(title + ' ' + author)}&searchType=smart`,
          multcolibLink: `https://multcolib.bibliocommons.com/v2/search?query=${encodeURIComponent(title + ' ' + author)}&searchType=smart`,
          attemptedV2: false
        };

        batchPromises.push(addDoc(collection(db, "books"), bookData));
        count++;
      }

      await Promise.all(batchPromises);
      alert(count > 0 ? `Successfully imported ${count} new books!` : "No new books found to import.");
    } catch (err) {
      console.error("Migration failed", err);
      alert("Migration failed: " + err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Filter books based on active tab
  const getDisplayBooks = () => {
    let books = [];
    if (activeTab === 'search') {
      books = searchResults;
    } else {
      // Filter by status and local search query
      books = myBooks.filter(b => 
        b.status === activeTab && 
        (
          b.title.toLowerCase().includes(filterQuery.toLowerCase()) ||
          (Array.isArray(b.author_name) ? b.author_name.join(' ') : (b.author_name || '')).toLowerCase().includes(filterQuery.toLowerCase())
        )
      );
      
      if (activeTab === 'scheduled') {
        // Earliest to latest for Scheduled
        books.sort((a, b) => new Date(a.sortDate) - new Date(b.sortDate));
      } else {
        // Latest to earliest for Read/Suggested
        books.sort((a, b) => {
          return new Date(b.sortDate) - new Date(a.sortDate);
        });
      }
    }
    return books;
  };

  return (
    <div className="app-container">
      <header>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
          {user ? (
            <div style={{ fontSize: '0.9rem' }}>
              Logged in as {user.email} 
              {isAdmin(user) && (
                <button onClick={migrateFromGoogleSheet} style={{ marginLeft: '10px', cursor: 'pointer', backgroundColor: '#e67e22', color: 'white', border: 'none', borderRadius: '4px', padding: '2px 8px' }}>
                  Import CSV
                </button>
              )}
              <button onClick={handleLogout} style={{ marginLeft: '10px', cursor: 'pointer' }}>Logout</button>
            </div>
          ) : (
            <button onClick={() => setShowLogin(!showLogin)} style={{ cursor: 'pointer' }}>Member Login</button>
          )}
        </div>

        {showLogin && !user && (
          <form onSubmit={handleLogin} style={{ marginBottom: '20px', padding: '15px', background: '#f0f0f0', borderRadius: '8px' }}>
            <input 
              type="email" 
              placeholder="Email" 
              value={email} 
              onChange={e => setEmail(e.target.value)} 
              style={{ marginRight: '10px', padding: '5px' }}
            />
            <input 
              type="password" 
              placeholder="Password" 
              value={password} 
              onChange={e => setPassword(e.target.value)} 
              style={{ marginRight: '10px', padding: '5px' }}
            />
            <button type="submit" style={{ padding: '5px 10px' }}>Login</button>
          </form>
        )}

        <img 
          src="https://images.unsplash.com/photo-1495446815901-a7297e633e8d?auto=format&fit=crop&w=800&q=80" 
          alt="Books and coffee" 
          className="header-image" 
        />
        <h1>📚 Book Club Tracker</h1>
        <p>Books we've read, scheduled books, and suggested books.</p>
      </header>

      {/* Search Section */}
      <form onSubmit={handleSearch} className="search-section">
        <input 
          type="text" 
          className="search-input"
          placeholder="Search Google Books..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="submit" className="search-btn" disabled={isLoading}>
          {isLoading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Quick Search Buttons */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <button onClick={() => fetchNYTList('combined-print-and-e-book-fiction')} className="tab-btn" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', background: '#e1bee7', color: '#4a148c' }}>🏆 Browse NYT Fiction</button>
        <button onClick={() => fetchNYTList('combined-print-and-e-book-nonfiction')} className="tab-btn" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', background: '#e1bee7', color: '#4a148c' }}>🏆 Browse NYT Non-Fiction</button>
        <button onClick={() => fetchNYTList('trade-fiction-paperback')} className="tab-btn" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', background: '#e1bee7', color: '#4a148c' }}>📖 Browse NYT Book Club Picks</button>
        <button onClick={() => handleQuickSearch('subject:mystery')} className="tab-btn" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', background: '#e1bee7', color: '#4a148c' }}>🕵️ Browse Mystery</button>
        <button onClick={() => handleQuickSearch('subject:biography')} className="tab-btn" style={{ fontSize: '0.85rem', padding: '0.5rem 1rem', background: '#e1bee7', color: '#4a148c' }}>👤 Browse Biographies</button>
      </div>

      {/* Navigation Tabs */}
      <div className="tabs">
        <button 
          className={`tab-btn ${activeTab === 'read' ? 'active' : ''}`}
          onClick={() => setActiveTab('read')}
        >
          📚Books We've Read({myBooks.filter(b => b.status === 'read').length})
        </button>
        <button 
          className={`tab-btn ${activeTab === 'scheduled' ? 'active' : ''}`}
          onClick={() => setActiveTab('scheduled')}
        >
          📅 Scheduled ({myBooks.filter(b => b.status === 'scheduled').length})
        </button>
        <button 
          className={`tab-btn ${activeTab === 'suggested' ? 'active' : ''}`}
          onClick={() => setActiveTab('suggested')}
        >
          💡 Suggested/Extras ({myBooks.filter(b => b.status === 'suggested').length})
        </button>
        {(searchResults.length > 0 || activeTab === 'search') && (
          <button 
            className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            🔍 Search Results
          </button>
        )}
      </div>

      {/* Local Filter Input (Only show when not searching API) */}
      {activeTab !== 'search' && (
        <input 
          type="text" 
          className="filter-input"
          placeholder={`Filter ${activeTab} books...`}
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
      )}

      {/* Book Grid */}
      <div className="book-grid">
        {getDisplayBooks().length === 0 ? (
          <div className="empty-state">
            {activeTab === 'search' 
              ? (isLoading ? "Searching..." : "No results found. Try a different search.")
              : "No books in this list yet."}
          </div>
        ) : (
          getDisplayBooks().map((book) => (
            <div key={book.key} className="book-card">
              <div className="book-info">
                <h3 className="book-title">{book.title}</h3>
                <p className="book-author">
                  {book.author_name ? (Array.isArray(book.author_name) ? book.author_name.join(', ') : book.author_name) : 'Unknown Author'}
                </p>
                
                {book.displayDate && (
                  <p className={`book-date ${book.status === 'scheduled' ? 'highlight' : ''}`}>
                    📅 {book.displayDate}
                  </p>
                )}
                {book.proposer && (
                  <p className="book-meta">👤 Proposed by: {book.proposer}</p>
                )}
                {book.comments && (
                  <p className="book-comments">"{book.comments}"</p>
                )}
                {book.goodreadsLink && (
                  <a href={book.goodreadsLink} target="_blank" rel="noopener noreferrer" className="book-link" style={{ display: 'block', marginTop: '0.5rem' }}>View on Goodreads →</a>
                )}
                {(book.wcclsLink || book.title) && (
                  <a href={book.wcclsLink || `https://wccls.bibliocommons.com/v2/search?query=${encodeURIComponent(book.title + (book.author_name ? ' ' + (Array.isArray(book.author_name) ? book.author_name.join(' ') : book.author_name) : ''))}&searchType=smart`} target="_blank" rel="noopener noreferrer" className="book-link">View on WCCLS →</a>
                )}
                {(book.multcolibLink || book.title) && (
                  <a href={book.multcolibLink || `https://multcolib.bibliocommons.com/v2/search?query=${encodeURIComponent(book.title + (book.author_name ? ' ' + (Array.isArray(book.author_name) ? book.author_name.join(' ') : book.author_name) : ''))}&searchType=smart`} target="_blank" rel="noopener noreferrer" className="book-link">View on Multnomah →</a>
                )}
                
                <div className="actions">
                  {activeTab === 'search' && (
                    <>
                      <button className="action-btn btn-suggest" onClick={() => addBookToFirebase(book, 'suggested')}>
                        + Add to Suggestions
                      </button>
                      {isAdmin(user) && (
                        <>
                          <button className="action-btn btn-read" onClick={() => addBookToFirebase(book, 'read')} style={{ marginTop: '5px' }}>
                            + Add to Read
                          </button>
                          <button className="action-btn btn-suggest" style={{ backgroundColor: '#8e44ad', marginTop: '5px' }} onClick={() => addBookToFirebase(book, 'scheduled')}>
                            + Add to Scheduled
                          </button>
                        </>
                      )}
                    </>
                  )}
                  {isAdmin(user) && activeTab !== 'search' && (
                    <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                      <button className="action-btn" style={{ backgroundColor: '#2980b9', color: 'white' }} onClick={() => editBook(book)}>
                        Edit
                      </button>
                      <button className="action-btn btn-remove" onClick={() => removeBook(book.key)}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default App;
