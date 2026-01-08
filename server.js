const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://pateldhyey418_db_user:UQZSbUPBN0Zk877e@cluster0.yb8dlob.mongodb.net/?appName=Cluster0', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log('MongoDB connected successfully');
    
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
};

startServer();

const Meal = require('./models/Meal');
const FavoriteMeal = require('./models/FavoriteMeal');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const getMealType = () => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return 'Breakfast';
  if (hour >= 11 && hour < 16) return 'Lunch';
  if (hour >= 16 && hour < 21) return 'Dinner';
  return 'Snack';
};

app.get('/list-models', (req, res) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`;
  
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => { data += chunk; });
    apiRes.on('end', () => {
      try {
        const jsonData = JSON.parse(data);
        const visionModels = jsonData.models?.filter(m => 
          m.supportedGenerationMethods?.includes('generateContent') &&
          (m.name.includes('vision') || m.name.includes('flash') || m.name.includes('pro'))
        ) || [];
        res.json({ 
          allModels: jsonData.models?.map(m => ({
            name: m.name,
            displayName: m.displayName,
            supportedMethods: m.supportedGenerationMethods
          })) || [],
          visionModels: visionModels.map(m => m.name),
          suggestion: 'Try using one of the vision models listed above'
        });
      } catch (error) {
        res.status(500).json({ 
          status: 'error', 
          message: error.message,
          rawResponse: data
        });
      }
    });
  }).on('error', (error) => {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      suggestion: 'Check your GEMINI_API_KEY in .env file'
    });
  });
});

app.get('/test-api', async (req, res) => {
  try {
    const testModel = genAI.getGenerativeModel({ model: 'gemini-pro' });
    const result = await testModel.generateContent('Say "API is working"');
    const response = await result.response;
    res.json({ 
      status: 'success', 
      message: response.text(),
      note: 'If this works, your API key is valid. Vision models may need to be enabled separately.'
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message,
      suggestion: 'Check your GEMINI_API_KEY in .env file'
    });
  }
});

app.post('/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file provided' });
  }

  const filePath = req.file.path;
  const dietaryPreference = req.body.dietaryPreference || 'Standard';
  const mealType = getMealType();

  try {
    const imageData = fs.readFileSync(filePath);
    const base64Image = imageData.toString('base64');

    let dietaryContext = '';
    if (dietaryPreference === 'Jain') {
      dietaryContext = 'CRITICAL: User follows Jain diet. FORBIDDEN items: onion, garlic, root vegetables (potato, carrot, radish, beetroot, turnip), non-vegetarian items. If detected, add explicit warning in advice.';
    } else if (dietaryPreference === 'Vegan') {
      dietaryContext = 'CRITICAL: User follows Vegan diet. FORBIDDEN: All dairy (milk, ghee, paneer, yogurt, butter, cheese), eggs, honey. If detected, warn in advice.';
    } else if (dietaryPreference === 'Keto') {
      dietaryContext = 'CRITICAL: User follows Keto diet. FLAG high-carb items (rice, roti, bread, potato) and suggest keto alternatives in advice. Target: <15g net carbs per meal.';
    } else if (dietaryPreference === 'High Protein') {
      dietaryContext = 'CRITICAL: User wants high protein meals. Target minimum 25-30g protein per meal. Highlight protein-rich items and suggest additions if protein is low.';
    }

    const systemPrompt = `You are an expert Indian nutritionist specializing in traditional Indian meals (Thalis). Analyze the meal image with high accuracy.

ANALYSIS REQUIREMENTS:
1. Identify EVERY food item visible - be specific (e.g., "Aloo Gobi" not just "Sabzi", "Dal Makhani" not just "Dal")
2. Estimate portion sizes accurately using Indian standard portions:
   - 1 Roti/Chapati: ~30g = 70-80 calories
   - 1 Katori Dal (150ml): 120-150 calories
   - 1 Katori Sabzi (100g): varies 50-200 calories based on type
   - 1 Katori Rice (150g cooked): 200-220 calories
   - 1 Papad: ~15g = 60-70 calories
   - Raita/Curd: ~100g = 50-80 calories
   - Salad: ~50g = 15-25 calories
   - Pickle: ~10g = 10-20 calories
   - Chutney: ~20g = 20-40 calories

3. Consider cooking methods:
   - Estimate oil/ghee used (typically 1-2 tsp per sabzi = 40-80 calories)
   - Fried items have higher calories
   - Gravy-based dishes have more calories than dry sabzis

4. Calculate macros accurately:
   - Protein: 4 calories per gram
   - Carbs: 4 calories per gram  
   - Fats: 9 calories per gram
   - Total calories = (protein × 4) + (carbs × 4) + (fats × 9)

${dietaryContext}

Return ONLY valid JSON (no markdown, no code blocks, no explanations):
{
  "items": [
    {
      "name": "Specific food name (e.g., 'Aloo Gobi', 'Dal Makhani', '2 Rotis')",
      "calories": number,
      "protein": number,
      "carbs": number,
      "fats": number
    }
  ],
  "total_calories": number,
  "macros_summary": {
    "protein": number,
    "carbs": number,
    "fats": number
  },
  "advice": "2-3 practical nutrition tips based on the meal analysis. ${dietaryPreference !== 'Standard' ? `Include ${dietaryPreference} specific recommendations.` : ''}"
}

CRITICAL: Ensure total_calories matches the sum of all item calories. Ensure macros_summary matches sum of all items' macros. Be precise and accurate.`;

    const modelNames = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.0-flash', 'gemini-2.5-flash-lite'];
    let result;
    let lastError;

    for (const modelName of modelNames) {
      try {
        console.log(`Trying model: ${modelName}`);
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          generationConfig: {
            temperature: 0.3,
            topP: 0.9,
            topK: 40,
          }
        });
        result = await model.generateContent([
          systemPrompt,
          {
            inlineData: {
              data: base64Image,
              mimeType: req.file.mimetype
            }
          }
        ]);
        console.log(`Successfully used model: ${modelName}`);
        break;
      } catch (modelError) {
        lastError = modelError;
        console.log(`Model ${modelName} failed: ${modelError.message}`);
        continue;
      }
    }

    if (!result) {
      throw lastError || new Error('All models failed. Please check your API key and model availability.');
    }

    const response = await result.response;
    const text = response.text();

    let jsonData;
    try {
      let cleanText = text.trim();
      cleanText = cleanText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }

      if (!jsonData.items || !Array.isArray(jsonData.items)) {
        throw new Error('Invalid response structure: missing items array');
      }

      const calculatedTotalCalories = jsonData.items.reduce((sum, item) => sum + (item.calories || 0), 0);
      const calculatedProtein = jsonData.items.reduce((sum, item) => sum + (item.protein || 0), 0);
      const calculatedCarbs = jsonData.items.reduce((sum, item) => sum + (item.carbs || 0), 0);
      const calculatedFats = jsonData.items.reduce((sum, item) => sum + (item.fats || 0), 0);

      const calorieDiff = Math.abs(calculatedTotalCalories - (jsonData.total_calories || 0));
      if (calorieDiff > 50) {
        console.warn(`Calorie mismatch: calculated ${calculatedTotalCalories}, reported ${jsonData.total_calories}. Using calculated value.`);
        jsonData.total_calories = Math.round(calculatedTotalCalories);
      }

      const proteinDiff = Math.abs(calculatedProtein - (jsonData.macros_summary?.protein || 0));
      const carbsDiff = Math.abs(calculatedCarbs - (jsonData.macros_summary?.carbs || 0));
      const fatsDiff = Math.abs(calculatedFats - (jsonData.macros_summary?.fats || 0));

      if (proteinDiff > 5 || carbsDiff > 5 || fatsDiff > 5) {
        console.warn('Macro mismatch detected, using calculated values.');
        jsonData.macros_summary = {
          protein: Math.round(calculatedProtein * 10) / 10,
          carbs: Math.round(calculatedCarbs * 10) / 10,
          fats: Math.round(calculatedFats * 10) / 10
        };
      }

      if (!jsonData.macros_summary) {
        jsonData.macros_summary = {
          protein: Math.round(calculatedProtein * 10) / 10,
          carbs: Math.round(calculatedCarbs * 10) / 10,
          fats: Math.round(calculatedFats * 10) / 10
        };
      }

    } catch (parseError) {
      console.error('Parse error:', parseError);
      return res.status(500).json({ 
        error: 'Failed to parse AI response',
        rawResponse: text.substring(0, 500)
      });
    }

    const mealData = {
      imageUrl: `data:${req.file.mimetype};base64,${base64Image}`,
      items: jsonData.items || [],
      totalCalories: jsonData.total_calories || 0,
      macros: {
        protein: jsonData.macros_summary?.protein || 0,
        carbs: jsonData.macros_summary?.carbs || 0,
        fats: jsonData.macros_summary?.fats || 0
      },
      timestamp: new Date(),
      mealType: mealType,
      dietaryPreference: dietaryPreference,
      advice: jsonData.advice || ''
    };

    const savedMeal = await Meal.create(mealData);
    console.log('Meal saved to MongoDB:', savedMeal._id);

    fs.unlinkSync(filePath);

    res.json({
      ...jsonData,
      id: savedMeal._id,
      mealType: mealType,
      dietaryPreference: dietaryPreference
    });
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    console.error('Error analyzing image:', error);
    res.status(500).json({ error: 'Failed to analyze image', details: error.message });
  }
});

app.get('/history', async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const meals = await Meal.find({
      timestamp: { $gte: sevenDaysAgo }
    })
    .sort({ timestamp: -1 })
    .lean();

    const formattedMeals = meals.map(meal => ({
      id: meal._id.toString(),
      items: meal.items,
      total_calories: meal.totalCalories,
      macros_summary: {
        protein: meal.macros.protein,
        carbs: meal.macros.carbs,
        fats: meal.macros.fats
      },
      timestamp: meal.timestamp,
      mealType: meal.mealType,
      dietaryPreference: meal.dietaryPreference,
      advice: meal.advice,
      createdAt: meal.createdAt || meal.timestamp
    }));

    res.json({ meals: formattedMeals });
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch meal history', details: error.message });
  }
});

app.post('/meals', async (req, res) => {
  try {
    const mealData = {
      imageUrl: req.body.imageUrl || '',
      items: req.body.items || [],
      totalCalories: req.body.total_calories || req.body.totalCalories || 0,
      macros: {
        protein: req.body.macros_summary?.protein || req.body.macros?.protein || 0,
        carbs: req.body.macros_summary?.carbs || req.body.macros?.carbs || 0,
        fats: req.body.macros_summary?.fats || req.body.macros?.fats || 0
      },
      timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
      mealType: req.body.mealType || getMealType(),
      dietaryPreference: req.body.dietaryPreference || 'Standard',
      advice: req.body.advice || ''
    };
    const newMeal = await Meal.create(mealData);
    res.json({ success: true, meal: newMeal });
  } catch (error) {
    console.error('Error saving meal:', error);
    res.status(500).json({ error: error.message, details: error.stack });
  }
});

app.get('/meals', async (req, res) => {
  try {
    const { date, limit } = req.query;
    let query = {};
    
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.timestamp = { $gte: startDate, $lte: endDate };
    }
    
    let mealsQuery = Meal.find(query).sort({ timestamp: -1 });
    
    if (limit) {
      mealsQuery = mealsQuery.limit(parseInt(limit));
    }
    
    const meals = await mealsQuery.lean();
    
    const formattedMeals = meals.map(meal => ({
      id: meal._id.toString(),
      ...meal,
      total_calories: meal.totalCalories,
      macros_summary: meal.macros,
      createdAt: meal.createdAt || meal.timestamp
    }));
    
    res.json({ meals: formattedMeals });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/meals/:id', async (req, res) => {
  try {
    await Meal.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/meals', async (req, res) => {
  try {
    const result = await Meal.deleteMany({});
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/stats', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    
    const recentMeals = await Meal.find({
      timestamp: { $gte: daysAgo }
    }).lean();
    
    const dailyStats = {};
    recentMeals.forEach(meal => {
      const date = new Date(meal.timestamp).toDateString();
      if (!dailyStats[date]) {
        dailyStats[date] = {
          date,
          totalCalories: 0,
          totalProtein: 0,
          totalCarbs: 0,
          totalFats: 0,
          mealCount: 0
        };
      }
      dailyStats[date].totalCalories += meal.totalCalories || 0;
      dailyStats[date].totalProtein += meal.macros?.protein || 0;
      dailyStats[date].totalCarbs += meal.macros?.carbs || 0;
      dailyStats[date].totalFats += meal.macros?.fats || 0;
      dailyStats[date].mealCount += 1;
    });
    
    res.json({ stats: Object.values(dailyStats) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/tracker', (req, res) => {
  try {
    const tracker = loadDailyTracker();
    const { date, goals } = req.body;
    const dateKey = new Date(date).toDateString();
    
    tracker[dateKey] = {
      date: dateKey,
      goals: goals || tracker[dateKey]?.goals || {
        calories: 2000,
        protein: 150,
        carbs: 250,
        fats: 65
      },
      updatedAt: new Date().toISOString()
    };
    
    saveDailyTracker(tracker);
    res.json({ success: true, tracker: tracker[dateKey] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/tracker', (req, res) => {
  try {
    const tracker = loadDailyTracker();
    const { date } = req.query;
    
    if (date) {
      const dateKey = new Date(date).toDateString();
      res.json({ tracker: tracker[dateKey] || null });
    } else {
      res.json({ tracker });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/export/csv', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let query = {};
    
    if (startDate && endDate) {
      query.timestamp = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    }
    
    const meals = await Meal.find(query).sort({ timestamp: -1 }).lean();
    
    const csvHeaders = 'Date,Meal Type,Dietary Preference,Total Calories,Protein (g),Carbs (g),Fats (g),Items,Advice\n';
    const csvRows = meals.map(meal => {
      const date = new Date(meal.timestamp).toISOString().split('T')[0];
      const items = (meal.items || []).map(item => item.name).join('; ');
      const advice = (meal.advice || '').replace(/,/g, ';').replace(/\n/g, ' ');
      return `${date},${meal.mealType || ''},${meal.dietaryPreference || 'Standard'},${meal.totalCalories || 0},${meal.macros?.protein || 0},${meal.macros?.carbs || 0},${meal.macros?.fats || 0},"${items}","${advice}"`;
    });
    
    const csv = csvHeaders + csvRows.join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=meals-export-${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/weekly-summary', async (req, res) => {
  try {
    const { weekStart } = req.query;
    const startDate = weekStart ? new Date(weekStart) : new Date();
    startDate.setDate(startDate.getDate() - startDate.getDay());
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
    
    const meals = await Meal.find({
      timestamp: { $gte: startDate, $lte: endDate }
    }).lean();
    
    const summary = {
      weekStart: startDate.toISOString().split('T')[0],
      weekEnd: endDate.toISOString().split('T')[0],
      totalMeals: meals.length,
      totalCalories: 0,
      avgDailyCalories: 0,
      totalProtein: 0,
      totalCarbs: 0,
      totalFats: 0,
      dailyBreakdown: {},
      mealTypeBreakdown: {},
      dietaryPreferenceBreakdown: {}
    };
    
    meals.forEach(meal => {
      summary.totalCalories += meal.totalCalories || 0;
      summary.totalProtein += meal.macros?.protein || 0;
      summary.totalCarbs += meal.macros?.carbs || 0;
      summary.totalFats += meal.macros?.fats || 0;
      
      const date = new Date(meal.timestamp).toISOString().split('T')[0];
      if (!summary.dailyBreakdown[date]) {
        summary.dailyBreakdown[date] = {
          calories: 0,
          protein: 0,
          carbs: 0,
          fats: 0,
          mealCount: 0
        };
      }
      summary.dailyBreakdown[date].calories += meal.totalCalories || 0;
      summary.dailyBreakdown[date].protein += meal.macros?.protein || 0;
      summary.dailyBreakdown[date].carbs += meal.macros?.carbs || 0;
      summary.dailyBreakdown[date].fats += meal.macros?.fats || 0;
      summary.dailyBreakdown[date].mealCount += 1;
      
      const mealType = meal.mealType || 'Other';
      summary.mealTypeBreakdown[mealType] = (summary.mealTypeBreakdown[mealType] || 0) + 1;
      
      const dietPref = meal.dietaryPreference || 'Standard';
      summary.dietaryPreferenceBreakdown[dietPref] = (summary.dietaryPreferenceBreakdown[dietPref] || 0) + 1;
    });
    
    const daysWithMeals = Object.keys(summary.dailyBreakdown).length;
    summary.avgDailyCalories = daysWithMeals > 0 ? Math.round(summary.totalCalories / daysWithMeals) : 0;
    
    res.json({ summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/meals/insights', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));
    
    const meals = await Meal.find({
      timestamp: { $gte: daysAgo }
    }).sort({ timestamp: -1 }).lean();
    
    if (meals.length === 0) {
      return res.json({ insights: ['Not enough meal data to generate insights. Start logging meals to see insights!'] });
    }
    
    const totalCalories = meals.reduce((sum, m) => sum + (m.totalCalories || 0), 0);
    const avgCalories = Math.round(totalCalories / meals.length);
    const totalProtein = meals.reduce((sum, m) => sum + (m.macros?.protein || 0), 0);
    const avgProtein = Math.round(totalProtein / meals.length);
    
    const mealTypes = {};
    meals.forEach(meal => {
      const type = meal.mealType || 'Other';
      mealTypes[type] = (mealTypes[type] || 0) + 1;
    });
    
    const mostCommonMealType = Object.keys(mealTypes).reduce((a, b) => 
      mealTypes[a] > mealTypes[b] ? a : b
    );
    
    const insights = [];
    
    if (avgCalories < 300) {
      insights.push(`Your average meal contains ${avgCalories} calories, which is quite light. Consider adding more nutrient-dense foods.`);
    } else if (avgCalories > 800) {
      insights.push(`Your average meal contains ${avgCalories} calories. Consider portion control for better weight management.`);
    } else {
      insights.push(`Your average meal contains ${avgCalories} calories, which is well-balanced.`);
    }
    
    if (avgProtein < 15) {
      insights.push(`Average protein per meal is ${avgProtein}g. Try including more protein-rich foods like dal, paneer, or legumes.`);
    } else if (avgProtein > 40) {
      insights.push(`Great! Your meals average ${avgProtein}g of protein, which is excellent for muscle maintenance.`);
    }
    
    insights.push(`You've logged ${meals.length} meals in the last ${days} days. ${mostCommonMealType} is your most common meal type.`);
    
    const recentMeals = meals.slice(0, 7);
    const recentAvgCal = Math.round(recentMeals.reduce((sum, m) => sum + (m.totalCalories || 0), 0) / recentMeals.length);
    if (recentAvgCal > avgCalories + 100) {
      insights.push(`Your recent meals have been higher in calories (${recentAvgCal} avg) compared to your overall average.`);
    } else if (recentAvgCal < avgCalories - 100) {
      insights.push(`Your recent meals have been lower in calories (${recentAvgCal} avg) - great for weight management!`);
    }
    
    res.json({ insights });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/favorites', async (req, res) => {
  try {
    const favoriteData = {
      name: req.body.name || 'Untitled Meal',
      items: req.body.items || [],
      totalCalories: req.body.totalCalories || 0,
      macros: {
        protein: req.body.macros?.protein || req.body.macros_summary?.protein || 0,
        carbs: req.body.macros?.carbs || req.body.macros_summary?.carbs || 0,
        fats: req.body.macros?.fats || req.body.macros_summary?.fats || 0
      },
      mealType: req.body.mealType || 'Lunch',
      dietaryPreference: req.body.dietaryPreference || 'Standard',
      createdAt: new Date()
    };
    
    const favorite = await FavoriteMeal.create(favoriteData);
    res.json({ success: true, favorite });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/favorites', async (req, res) => {
  try {
    const favorites = await FavoriteMeal.find().sort({ createdAt: -1 }).lean();
    res.json({ favorites });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/favorites/:id', async (req, res) => {
  try {
    await FavoriteMeal.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/meals/quick-add', async (req, res) => {
  try {
    const mealData = {
      imageUrl: '',
      items: req.body.items || [],
      totalCalories: req.body.total_calories || req.body.totalCalories || 0,
      macros: {
        protein: req.body.macros_summary?.protein || req.body.macros?.protein || 0,
        carbs: req.body.macros_summary?.carbs || req.body.macros?.carbs || 0,
        fats: req.body.macros_summary?.fats || req.body.macros?.fats || 0
      },
      timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
      mealType: req.body.mealType || getMealType(),
      dietaryPreference: req.body.dietaryPreference || 'Standard',
      advice: req.body.advice || 'Manually added meal'
    };
    
    const newMeal = await Meal.create(mealData);
    res.json({ success: true, meal: newMeal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function loadDailyTracker() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const filePath = path.join(dataDir, 'tracker.json');
  if (fs.existsSync(filePath)) {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  }
  return {};
}

function saveDailyTracker(tracker) {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const filePath = path.join(dataDir, 'tracker.json');
  fs.writeFileSync(filePath, JSON.stringify(tracker, null, 2));
}

// ==========================================
// GEMINI AI HELPER WITH RETRY LOGIC
// ==========================================

const AI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite','gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro', 'gemini-2.0-flash'];

async function callGeminiWithRetry(prompt, config = {}) {
  const { temperature = 0.7, maxOutputTokens = 1000, retries = 2 } = config;
  let lastError = null;

  for (const modelName of AI_MODELS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
        
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: { temperature, maxOutputTokens, topP: 0.9 }
        });
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
      } catch (error) {
        lastError = error;
        console.log(`Model ${modelName} attempt ${attempt + 1} failed:`, error.message?.substring(0, 100));
        
        // If rate limited or service unavailable, try next model immediately
        if (error.status === 429 || error.status === 503) {
          break; // Try next model
        }
      }
    }
  }

  throw lastError || new Error('All AI models failed');
}

// ==========================================
// NEW AI-POWERED ENDPOINTS
// ==========================================

// AI Chat - Nutrition Q&A Assistant
app.post('/ai/chat', async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get recent meals for context
    const recentMeals = await Meal.find()
      .sort({ timestamp: -1 })
      .limit(5)
      .lean();

    const mealContext = recentMeals.length > 0 
      ? `User's recent meals: ${recentMeals.map(m => m.items?.map(i => i.name).join(', ')).join('; ')}`
      : 'No recent meal data available';

    const systemPrompt = `You are a friendly, knowledgeable Indian nutrition expert assistant named "Thali AI". You help users with nutrition questions, focusing on Indian cuisine and traditional foods.

CONTEXT:
${mealContext}

GUIDELINES:
1. Give concise, practical advice (2-3 sentences max for simple questions)
2. Focus on Indian foods and cooking methods
3. Include specific food examples from Indian cuisine (dal, roti, sabzi, etc.)
4. Be encouraging and supportive
5. If asked about non-nutrition topics, politely redirect to nutrition
6. Use emojis sparingly to be friendly 🍛

Previous conversation:
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

User question: ${message}

Respond naturally as a helpful nutrition assistant:`;

    const aiMessage = await callGeminiWithRetry(systemPrompt, { temperature: 0.7, maxOutputTokens: 500 });

    res.json({
      success: true,
      message: aiMessage,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Chat error:', error);
    res.status(500).json({ error: 'Failed to get AI response. API rate limit may be reached. Please try again in a few seconds.', details: error.message });
  }
});

// AI Meal Suggestions - Smart recommendations based on history
app.get('/ai/suggestions', async (req, res) => {
  try {
    const { dietaryPreference = 'Standard' } = req.query;

    // Get recent meals and goals
    const recentMeals = await Meal.find()
      .sort({ timestamp: -1 })
      .limit(10)
      .lean();

    const tracker = loadDailyTracker();
    const today = new Date().toDateString();
    const goals = tracker[today]?.goals || { calories: 2000, protein: 150, carbs: 250, fats: 65 };

    // Calculate today's consumption
    const todayMeals = recentMeals.filter(m => 
      new Date(m.timestamp).toDateString() === today
    );
    
    const consumed = todayMeals.reduce((acc, meal) => ({
      calories: acc.calories + (meal.totalCalories || 0),
      protein: acc.protein + (meal.macros?.protein || 0),
      carbs: acc.carbs + (meal.macros?.carbs || 0),
      fats: acc.fats + (meal.macros?.fats || 0)
    }), { calories: 0, protein: 0, carbs: 0, fats: 0 });

    const remaining = {
      calories: Math.max(0, goals.calories - consumed.calories),
      protein: Math.max(0, goals.protein - consumed.protein),
      carbs: Math.max(0, goals.carbs - consumed.carbs),
      fats: Math.max(0, goals.fats - consumed.fats)
    };

    const recentFoods = recentMeals.flatMap(m => m.items?.map(i => i.name) || []).slice(0, 15);
    const mealType = getMealType();

    let dietContext = '';
    if (dietaryPreference === 'Jain') {
      dietContext = 'MUST follow Jain diet: NO onion, garlic, root vegetables (potato, carrot, radish, beetroot), non-veg.';
    } else if (dietaryPreference === 'Vegan') {
      dietContext = 'MUST be Vegan: NO dairy (milk, ghee, paneer, yogurt, butter), eggs, honey.';
    } else if (dietaryPreference === 'Keto') {
      dietContext = 'MUST be Keto-friendly: Very low carb (<10g per meal), high fat, moderate protein.';
    } else if (dietaryPreference === 'High Protein') {
      dietContext = 'MUST be high protein: At least 25-30g protein per meal suggestion.';
    }

    const prompt = `You are an Indian nutrition expert. Suggest 4 meal options for ${mealType}.

USER CONTEXT:
- Dietary Preference: ${dietaryPreference}
- ${dietContext}
- Remaining goals today: ${remaining.calories} cal, ${remaining.protein}g protein, ${remaining.carbs}g carbs, ${remaining.fats}g fats
- Recently eaten: ${recentFoods.join(', ') || 'No recent data'}

REQUIREMENTS:
1. Suggest 4 different Indian meal options
2. Include variety (different from recent meals)
3. Each meal should help meet remaining nutritional goals
4. Include specific portions

Return ONLY valid JSON (no markdown):
{
  "suggestions": [
    {
      "name": "Meal name (e.g., 'Paneer Bhurji with 2 Rotis')",
      "description": "Brief 1-line description",
      "calories": number,
      "protein": number,
      "carbs": number,
      "fats": number,
      "reason": "Why this meal is suggested (1 line)"
    }
  ]
}`;

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 0.8, topP: 0.9 }
    });

    let text = await callGeminiWithRetry(prompt, { temperature: 0.8, maxOutputTokens: 1500 });
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid AI response format');
    }

    const data = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      suggestions: data.suggestions || [],
      context: {
        mealType,
        dietaryPreference,
        remaining
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions. API rate limit may be reached.', details: error.message });
  }
});

// AI Health Score - Personalized health scoring
app.get('/ai/health-score', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    const meals = await Meal.find({
      timestamp: { $gte: daysAgo }
    }).lean();

    if (meals.length < 3) {
      return res.json({
        success: true,
        score: null,
        message: 'Need at least 3 meals to calculate health score. Keep logging!',
        mealsLogged: meals.length,
        mealsNeeded: 3
      });
    }

    // Calculate basic stats
    const totalCalories = meals.reduce((sum, m) => sum + (m.totalCalories || 0), 0);
    const avgCalories = Math.round(totalCalories / meals.length);
    const totalProtein = meals.reduce((sum, m) => sum + (m.macros?.protein || 0), 0);
    const avgProtein = Math.round(totalProtein / meals.length);
    const totalCarbs = meals.reduce((sum, m) => sum + (m.macros?.carbs || 0), 0);
    const totalFats = meals.reduce((sum, m) => sum + (m.macros?.fats || 0), 0);

    // Get unique food items for variety score
    const allFoods = meals.flatMap(m => m.items?.map(i => i.name.toLowerCase()) || []);
    const uniqueFoods = [...new Set(allFoods)];

    // Meal types distribution
    const mealTypes = {};
    meals.forEach(m => {
      const type = m.mealType || 'Other';
      mealTypes[type] = (mealTypes[type] || 0) + 1;
    });

    const prompt = `You are a nutrition health analyst. Calculate a health score (0-100) based on this data:

MEAL DATA (Last ${days} days):
- Total meals: ${meals.length}
- Average calories per meal: ${avgCalories}
- Average protein per meal: ${avgProtein}g
- Total protein: ${totalProtein}g, Carbs: ${totalCarbs}g, Fats: ${totalFats}g
- Unique foods eaten: ${uniqueFoods.length} (${uniqueFoods.slice(0, 10).join(', ')})
- Meal type distribution: ${JSON.stringify(mealTypes)}

SCORING CRITERIA:
1. Balance (0-35): Are macros well-balanced? (Ideal: 25-30% protein, 45-55% carbs, 20-30% fats)
2. Variety (0-35): How diverse are the food choices? (More unique foods = better)
3. Consistency (0-30): Regular meal patterns and appropriate portions?

Return ONLY valid JSON:
{
  "overallScore": number (0-100),
  "breakdown": {
    "balance": { "score": number (0-35), "feedback": "1 line feedback" },
    "variety": { "score": number (0-35), "feedback": "1 line feedback" },
    "consistency": { "score": number (0-30), "feedback": "1 line feedback" }
  },
  "topTip": "Most important improvement suggestion (1-2 lines)",
  "strengths": ["strength 1", "strength 2"],
  "improvements": ["improvement 1", "improvement 2"]
}`;

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 0.3 }
    });

    let text = await callGeminiWithRetry(prompt, { temperature: 0.3, maxOutputTokens: 1500 });
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid AI response format');
    }

    const scoreData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...scoreData,
      stats: {
        mealsAnalyzed: meals.length,
        daysAnalyzed: parseInt(days),
        avgCalories,
        avgProtein,
        uniqueFoodsCount: uniqueFoods.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Health Score error:', error);
    res.status(500).json({ error: 'Failed to calculate health score. API rate limit may be reached.', details: error.message });
  }
});

// AI Insights - Deep pattern analysis (Enhanced version)
app.get('/ai/insights', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    const meals = await Meal.find({
      timestamp: { $gte: daysAgo }
    }).sort({ timestamp: -1 }).lean();

    if (meals.length < 5) {
      return res.json({
        success: true,
        insights: [{
          type: 'info',
          title: 'Keep Logging!',
          content: `You've logged ${meals.length} meals. Log at least 5 meals to unlock AI-powered insights!`
        }],
        mealsAnalyzed: meals.length
      });
    }

    // Prepare comprehensive data for AI
    const dailyData = {};
    meals.forEach(meal => {
      const date = new Date(meal.timestamp).toDateString();
      if (!dailyData[date]) {
        dailyData[date] = { calories: 0, protein: 0, carbs: 0, fats: 0, mealCount: 0, mealTypes: [] };
      }
      dailyData[date].calories += meal.totalCalories || 0;
      dailyData[date].protein += meal.macros?.protein || 0;
      dailyData[date].carbs += meal.macros?.carbs || 0;
      dailyData[date].fats += meal.macros?.fats || 0;
      dailyData[date].mealCount += 1;
      dailyData[date].mealTypes.push(meal.mealType || 'Other');
    });

    const allFoods = meals.flatMap(m => m.items?.map(i => i.name) || []);
    const foodFrequency = {};
    allFoods.forEach(food => {
      foodFrequency[food] = (foodFrequency[food] || 0) + 1;
    });
    const topFoods = Object.entries(foodFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, count]) => `${name} (${count}x)`);

    const dietaryPrefs = {};
    meals.forEach(m => {
      const pref = m.dietaryPreference || 'Standard';
      dietaryPrefs[pref] = (dietaryPrefs[pref] || 0) + 1;
    });

    const prompt = `You are an expert nutritionist analyzing eating patterns. Provide 5 personalized, actionable insights.

DATA SUMMARY (Last ${days} days):
- Total meals: ${meals.length}
- Days with data: ${Object.keys(dailyData).length}
- Daily patterns: ${JSON.stringify(Object.values(dailyData).slice(0, 7))}
- Most eaten foods: ${topFoods.join(', ')}
- Dietary preferences used: ${JSON.stringify(dietaryPrefs)}

INSIGHT REQUIREMENTS:
1. Be specific to THIS user's data
2. Each insight should be actionable
3. Mix positive observations with improvements
4. Focus on Indian food context
5. Include specific food suggestions

Return ONLY valid JSON:
{
  "insights": [
    {
      "type": "positive|warning|tip|pattern|goal",
      "emoji": "appropriate emoji",
      "title": "Short title (3-5 words)",
      "content": "Detailed insight (2-3 sentences max)",
      "action": "Specific action to take (optional)"
    }
  ],
  "summary": "One-line overall assessment"
}`;

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 0.7 }
    });

    let text = await callGeminiWithRetry(prompt, { temperature: 0.7, maxOutputTokens: 2000 });
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid AI response format');
    }

    const insightsData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...insightsData,
      mealsAnalyzed: meals.length,
      daysAnalyzed: parseInt(days),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Insights error:', error);
    res.status(500).json({ error: 'Failed to generate insights. API rate limit may be reached.', details: error.message });
  }
});

// AI Meal Planner - Weekly meal plan generation
app.post('/ai/meal-plan', async (req, res) => {
  try {
    const { 
      dietaryPreference = 'Standard', 
      calorieGoal = 2000,
      days = 7,
      mealsPerDay = 3,
      excludeFoods = []
    } = req.body;

    let dietContext = '';
    if (dietaryPreference === 'Jain') {
      dietContext = 'Jain diet: NO onion, garlic, root vegetables (potato, carrot, radish, beetroot, turnip), non-veg items.';
    } else if (dietaryPreference === 'Vegan') {
      dietContext = 'Vegan diet: NO dairy (milk, ghee, paneer, yogurt, butter, cheese), eggs, honey.';
    } else if (dietaryPreference === 'Keto') {
      dietContext = 'Keto diet: Very low carb (<50g/day), high fat, moderate protein. Focus on paneer, eggs, low-carb vegetables.';
    } else if (dietaryPreference === 'High Protein') {
      dietContext = 'High Protein diet: Target 150g+ protein daily. Include protein in every meal.';
    }

    const caloriesPerMeal = Math.round(calorieGoal / mealsPerDay);

    const prompt = `You are an Indian meal planning expert. Create a ${days}-day meal plan.

REQUIREMENTS:
- Dietary Preference: ${dietaryPreference}
- ${dietContext}
- Daily Calorie Target: ${calorieGoal} kcal
- Meals per day: ${mealsPerDay} (${caloriesPerMeal} kcal each approx)
- Foods to exclude: ${excludeFoods.length > 0 ? excludeFoods.join(', ') : 'None'}

GUIDELINES:
1. Use authentic Indian recipes and ingredients
2. Ensure variety - don't repeat same meal within 3 days
3. Balance macros throughout the day
4. Include practical, easy-to-cook meals
5. Consider meal prep efficiency

Return ONLY valid JSON:
{
  "mealPlan": [
    {
      "day": 1,
      "dayName": "Monday",
      "meals": [
        {
          "type": "Breakfast|Lunch|Dinner|Snack",
          "name": "Meal name",
          "items": ["item1", "item2"],
          "calories": number,
          "protein": number,
          "carbs": number,
          "fats": number,
          "prepTime": "15 mins"
        }
      ],
      "dailyTotals": { "calories": number, "protein": number, "carbs": number, "fats": number }
    }
  ],
  "weeklyOverview": {
    "avgDailyCalories": number,
    "avgDailyProtein": number,
    "shoppingListCategories": ["Vegetables", "Dairy", "Grains", "Spices"]
  },
  "tips": ["meal prep tip 1", "tip 2"]
}`;

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      generationConfig: { temperature: 0.8, maxOutputTokens: 4000 }
    });

    let text = await callGeminiWithRetry(prompt, { temperature: 0.8, maxOutputTokens: 4000 });
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Invalid AI response format');
    }

    const planData = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...planData,
      parameters: {
        dietaryPreference,
        calorieGoal,
        days,
        mealsPerDay
      },
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Meal Plan error:', error);
    res.status(500).json({ error: 'Failed to generate meal plan. API rate limit may be reached.', details: error.message });
  }
});

// ==========================================
// PHASE 2: ADDITIONAL AI FEATURES
// ==========================================

// AI Recipe Generator - Create recipes from ingredients
app.post('/ai/recipe', async (req, res) => {
  try {
    const { 
      ingredients = [], 
      dietaryPreference = 'Standard',
      cuisineType = 'Indian',
      mealType = 'Any',
      maxPrepTime = 60
    } = req.body;

    if (ingredients.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one ingredient' });
    }

    let dietContext = '';
    if (dietaryPreference === 'Jain') {
      dietContext = 'Jain diet: NO onion, garlic, root vegetables, non-veg.';
    } else if (dietaryPreference === 'Vegan') {
      dietContext = 'Vegan diet: NO dairy, eggs, honey.';
    } else if (dietaryPreference === 'Keto') {
      dietContext = 'Keto diet: Very low carb, high fat.';
    }

    const prompt = `You are an expert Indian chef and nutritionist. Create 3 healthy recipes using the given ingredients.

AVAILABLE INGREDIENTS:
${ingredients.join(', ')}

REQUIREMENTS:
- Dietary Preference: ${dietaryPreference} ${dietContext}
- Cuisine: ${cuisineType}
- Meal Type: ${mealType}
- Max Prep Time: ${maxPrepTime} minutes
- Recipes should be healthy and nutritious
- Include nutrition estimates per serving

Return ONLY valid JSON:
{
  "recipes": [
    {
      "name": "Recipe name",
      "description": "Brief description",
      "prepTime": "20 mins",
      "cookTime": "15 mins",
      "servings": 2,
      "difficulty": "Easy|Medium|Hard",
      "ingredients": [
        { "item": "ingredient", "quantity": "1 cup" }
      ],
      "instructions": ["Step 1", "Step 2"],
      "nutrition": {
        "calories": 350,
        "protein": 15,
        "carbs": 40,
        "fats": 12
      },
      "tips": "Chef tip for this recipe"
    }
  ]
}`;

    const text = await callGeminiWithRetry(prompt, { temperature: 0.8, maxOutputTokens: 3000 });
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) throw new Error('Invalid AI response');
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...data,
      parameters: { ingredients, dietaryPreference, cuisineType, mealType },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('AI Recipe error:', error);
    res.status(500).json({ error: 'Failed to generate recipes. Please try again.', details: error.message });
  }
});

// Text-to-Calories - Estimate calories from text description
app.post('/ai/text-to-calories', async (req, res) => {
  try {
    const { mealDescription } = req.body;

    if (!mealDescription || mealDescription.trim().length < 3) {
      return res.status(400).json({ error: 'Please provide a meal description' });
    }

    const prompt = `You are an expert nutritionist. Analyze this meal description and estimate its nutritional content.

MEAL DESCRIPTION:
"${mealDescription}"

REQUIREMENTS:
1. Identify all food items mentioned
2. Estimate portion sizes based on context
3. Calculate accurate nutrition values
4. Assume Indian food context if not specified
5. Be realistic with portions

Return ONLY valid JSON:
{
  "interpretation": "How you interpreted the meal",
  "items": [
    {
      "name": "Food item",
      "estimatedPortion": "1 bowl (150g)",
      "calories": 250,
      "protein": 10,
      "carbs": 35,
      "fats": 8
    }
  ],
  "totals": {
    "calories": number,
    "protein": number,
    "carbs": number,
    "fats": number
  },
  "confidence": "high|medium|low",
  "notes": "Any assumptions made"
}`;

    const text = await callGeminiWithRetry(prompt, { temperature: 0.3, maxOutputTokens: 1500 });
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) throw new Error('Invalid AI response');
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...data,
      originalDescription: mealDescription,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Text-to-Calories error:', error);
    res.status(500).json({ error: 'Failed to analyze meal description.', details: error.message });
  }
});

// Food Comparison - Compare two foods nutritionally
app.post('/ai/compare-foods', async (req, res) => {
  try {
    const { food1, food2, portion1 = '100g', portion2 = '100g' } = req.body;

    if (!food1 || !food2) {
      return res.status(400).json({ error: 'Please provide two foods to compare' });
    }

    const prompt = `You are a nutrition expert. Compare these two foods in detail.

COMPARISON:
Food 1: ${food1} (${portion1})
Food 2: ${food2} (${portion2})

Provide a detailed nutritional comparison with Indian food context.

Return ONLY valid JSON:
{
  "food1": {
    "name": "${food1}",
    "portion": "${portion1}",
    "calories": number,
    "protein": number,
    "carbs": number,
    "fats": number,
    "fiber": number,
    "keyNutrients": ["Vitamin A", "Iron"],
    "healthBenefits": ["benefit 1", "benefit 2"]
  },
  "food2": {
    "name": "${food2}",
    "portion": "${portion2}",
    "calories": number,
    "protein": number,
    "carbs": number,
    "fats": number,
    "fiber": number,
    "keyNutrients": ["Vitamin C", "Calcium"],
    "healthBenefits": ["benefit 1", "benefit 2"]
  },
  "comparison": {
    "calorieWinner": "food1|food2",
    "proteinWinner": "food1|food2",
    "healthierChoice": "food1|food2",
    "explanation": "Why one is healthier than the other"
  },
  "recommendation": "When to choose each food (2-3 sentences)"
}`;

    const text = await callGeminiWithRetry(prompt, { temperature: 0.3, maxOutputTokens: 2000 });
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) throw new Error('Invalid AI response');
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Food Comparison error:', error);
    res.status(500).json({ error: 'Failed to compare foods.', details: error.message });
  }
});

// AI Diet Coach - Personalized diet advice based on goals
app.post('/ai/diet-coach', async (req, res) => {
  try {
    const { 
      goal = 'maintenance', // weightLoss, muscleGain, maintenance, healthyEating
      currentWeight,
      targetWeight,
      activityLevel = 'moderate', // sedentary, light, moderate, active, veryActive
      dietaryPreference = 'Standard',
      challenges = []
    } = req.body;

    // Get recent meal data for context
    const recentMeals = await Meal.find()
      .sort({ timestamp: -1 })
      .limit(14)
      .lean();

    const avgCalories = recentMeals.length > 0 
      ? Math.round(recentMeals.reduce((sum, m) => sum + (m.totalCalories || 0), 0) / recentMeals.length)
      : 'unknown';

    const prompt = `You are a personal diet coach specializing in Indian nutrition. Provide personalized coaching.

USER PROFILE:
- Goal: ${goal}
- Current Weight: ${currentWeight || 'Not specified'}
- Target Weight: ${targetWeight || 'Not specified'}
- Activity Level: ${activityLevel}
- Dietary Preference: ${dietaryPreference}
- Challenges: ${challenges.join(', ') || 'None specified'}
- Average calories per meal (recent): ${avgCalories}

Provide motivational, actionable coaching advice focused on Indian dietary habits.

Return ONLY valid JSON:
{
  "greeting": "Personalized encouraging greeting",
  "assessment": "Brief assessment of their situation",
  "dailyCalorieTarget": number,
  "macroTargets": {
    "protein": "grams per day",
    "carbs": "grams per day",
    "fats": "grams per day"
  },
  "actionPlan": [
    {
      "priority": 1,
      "action": "Specific action to take",
      "reason": "Why this matters"
    }
  ],
  "mealTiming": {
    "breakfast": "7-8 AM - what to eat",
    "lunch": "12-1 PM - what to eat",
    "dinner": "7-8 PM - what to eat",
    "snacks": "Healthy snack suggestions"
  },
  "weeklyGoals": ["Goal 1", "Goal 2", "Goal 3"],
  "motivationalTip": "Encouraging message for the user",
  "indianFoodsToPrioritize": ["food 1", "food 2", "food 3"],
  "foodsToLimit": ["food 1", "food 2"]
}`;

    const text = await callGeminiWithRetry(prompt, { temperature: 0.7, maxOutputTokens: 2500 });
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) throw new Error('Invalid AI response');
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...data,
      mealsAnalyzed: recentMeals.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Diet Coach error:', error);
    res.status(500).json({ error: 'Failed to generate diet coaching.', details: error.message });
  }
});

// Smart Grocery List - Generate grocery list from meal plan
app.post('/ai/grocery-list', async (req, res) => {
  try {
    const { 
      days = 7,
      mealsPerDay = 3,
      dietaryPreference = 'Standard',
      budget = 'medium', // low, medium, high
      familySize = 2
    } = req.body;

    // Get favorite meals for personalization
    const favoriteMeals = await FavoriteMeal.find().limit(5).lean();
    const favoriteItems = favoriteMeals.flatMap(m => m.items?.map(i => i.name) || []);

    let dietContext = '';
    if (dietaryPreference === 'Jain') {
      dietContext = 'EXCLUDE: onion, garlic, root vegetables, non-veg';
    } else if (dietaryPreference === 'Vegan') {
      dietContext = 'EXCLUDE: all dairy, eggs, honey';
    }

    const prompt = `You are an Indian home cook expert. Create a smart grocery shopping list.

REQUIREMENTS:
- Days to plan for: ${days}
- Meals per day: ${mealsPerDay}
- Family size: ${familySize}
- Dietary Preference: ${dietaryPreference} ${dietContext}
- Budget: ${budget}
- User's favorite items: ${favoriteItems.join(', ') || 'Not available'}

Create a comprehensive Indian grocery list organized by category.

Return ONLY valid JSON:
{
  "groceryList": {
    "vegetables": [
      { "item": "Tomatoes", "quantity": "1 kg", "estimatedCost": 40 }
    ],
    "fruits": [],
    "dairy": [],
    "grains": [],
    "pulses": [],
    "spices": [],
    "oils": [],
    "others": []
  },
  "estimatedTotalCost": number,
  "mealSuggestions": ["Meal 1", "Meal 2", "Meal 3"],
  "shoppingTips": ["Tip 1", "Tip 2"],
  "storageAdvice": "How to store items for the week"
}`;

    const text = await callGeminiWithRetry(prompt, { temperature: 0.7, maxOutputTokens: 3000 });
    const cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) throw new Error('Invalid AI response');
    const data = JSON.parse(jsonMatch[0]);

    res.json({
      success: true,
      ...data,
      parameters: { days, mealsPerDay, familySize, dietaryPreference, budget },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Grocery List error:', error);
    res.status(500).json({ error: 'Failed to generate grocery list.', details: error.message });
  }
});


