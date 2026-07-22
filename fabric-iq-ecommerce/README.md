# City Cart — e-commerce demo data

The dataset for **[Build an e-commerce ontology in Microsoft Fabric IQ](https://ravichanduedru.me/articles/fabric-iq/build-ecommerce-ontology-fabric-iq)**.

City Cart is a fictional online marketplace: sellers list products, and customers across India buy them. Eight CSV files hold the whole business. On their own, none of them answers a real question — which is exactly the problem the ontology in the article solves.

## Files

| File | Rows | Columns | Links to |
|------|------|---------|----------|
| `customers.csv` | 60 | CustomerID, Name, Email, Segment, JoinDate, TotalSpend, CategoryID, CityID | categories, cities |
| `orders.csv` | 121 | OrderID, CustomerID, SellerID, Amount, OrderDate, DeliveryDate, PaymentMethod, OrderStatusID | customers, sellers, order_status |
| `order_items.csv` | 256 | OrderItemID, OrderID, ProductID, Quantity, UnitPrice, LineTotal | orders, products |
| `products.csv` | 40 | ProductID, Name, Price, SKU, Rating, StockLevel, CategoryID, SellerID | categories, sellers |
| `sellers.csv` | 8 | SellerID, Name, ResponseTimeHours, ReturnRatePct, CategoryID, CityID | categories, cities |
| `categories.csv` | 8 | CategoryID, Name, Description | — |
| `cities.csv` | 12 | CityID, Name, State, Country | — |
| `order_status.csv` | 5 | OrderStatusID, StatusName, IsTerminal | — |

## How the tables connect

- An **order** is placed by a **customer**, fulfilled by a **seller**, and has a **status**.
- An **order** is made of **order items** (line items). Each line item refers to one **product**.
- A **product** belongs to a **category** and is sold by a **seller**.
- A **customer** is located in a **city** and prefers a **category**.
- A **seller** specializes in a **category** and is based in a **city**.

There is no direct order-to-product link. To find what is in an order, you go through its order items. That junction is why one order can carry several products at different prices.

## Notes on the data

- Money columns (`Amount`, `Price`, `TotalSpend`, `UnitPrice`, `LineTotal`) are written with two decimal places, so they infer as **double**.
- `order_status.IsTerminal` is `true` for Delivered, Returned, and Cancelled; `false` for Processing and Shipped.
- `DeliveryDate` is empty for Processing, Shipped, and Cancelled orders alike, so an empty value does not mean a customer is waiting.

## Use it

Download the eight files, upload them to a Microsoft Fabric lakehouse, and follow the [article](https://ravichanduedru.me/articles/fabric-iq/build-ecommerce-ontology-fabric-iq).
