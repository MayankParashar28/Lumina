
// <script src="https://www.google.com/recaptcha/api.js"></script>

// function onSubmit(token) {
//   document.getElementById("demo-form").submit();
// }




//   async function searchBlogs() {
//     const query = document.getElementById("searchQuery").value.trim();
//     if (query.length === 0) {
//       document.getElementById("searchResults").innerHTML = "";
//       return;
//     }

//     try {
//       const response = await fetch(`/search?search=${query}`);
//       const blogs = await response.json();

//       let resultsHtml = "";
//       blogs.forEach(blog => {
//         let highlightedTitle = highlightMatch(blog.title, query);
//         let highlightedBody = highlightMatch(blog.body, query, 100); // Show 100 chars

//         resultsHtml += `
//           <div class="search-result">
//             <h5>${highlightedTitle}</h5>
//             <p>${highlightedBody}</p>
//             <a href="/blog/${blog._id}" class="btn btn-primary">Read More</a>
//           </div>
//           <hr>
//         `;
//       });

//       document.getElementById("searchResults").innerHTML = resultsHtml;
//     } catch (err) {
//       console.error("Error fetching search results:", err);
//     }
//   }

//   function highlightMatch(text, query, limit = null) {
//     if (!text) return "";
//     if (limit) text = text.substring(0, limit) + "...";

//     const regex = new RegExp(query, "gi");
//     return text.replace(regex, match => `<mark>${match}</mark>`);
//   }

